import {
  type BridgeSessionManifest,
  type DetectionResult,
  encodeEventLine,
  encodeSessionJson,
  type HarnessCapabilities,
  type HarnessId,
  PROTOCOL_VERSION,
  type SessionCapabilities,
  type SessionDescriptor,
  type SessionEvent,
  type SessionId
} from "@agentbridge/schema"
import { Context, type Duration, Effect, FileSystem, Layer, Option, Path, Schedule, Stream } from "effect"
import {
  type AdapterUnavailable,
  type BridgeError,
  CapabilityNotSupported,
  describeCause,
  ExportError,
  type SessionNotFound,
  type SessionReadError,
  type StoreError
} from "./errors.ts"
import type { HarnessAdapterShape, ListSessionsOptions } from "./HarnessAdapter.ts"
import { HarnessRegistry } from "./HarnessRegistry.ts"
import { type LoadedSession, loadSession, sequenceEvents } from "./normalize.ts"
import { SessionStore } from "./SessionStore.ts"
import { enrichment, enrichStream, redactionEnricher, redactSession, type SessionEnricher } from "./enrich.ts"
import { GitRepository, verifyGitCommit } from "./GitRepository.ts"

export interface HarnessInfo {
  readonly id: HarnessId
  readonly name: string
  readonly capabilities: HarnessCapabilities
}

export interface ExportResult {
  readonly directory: string
  readonly manifest: BridgeSessionManifest
}

export interface IndexResult extends LoadedSession {
  /** The store was already up to date with the source. */
  readonly skipped: boolean
}

/** Identifies a source's state cheaply: size and modification time (or last update for database rows). */
export const sourceFingerprint = (descriptor: SessionDescriptor): string =>
  `${descriptor.sourcePath}|${descriptor.sizeBytes ?? "-"}|${descriptor.updatedAt ?? "-"}`

export interface ReadOptions {
  /** Opt-in enrichers (e.g. `gitEnricher`, `redactionEnricher`), applied in order. */
  readonly enrichers?: ReadonlyArray<SessionEnricher> | undefined
  /**
   * Check derived `git.commit` events against the session's repository and mark the ones
   * found `known`. Needs a `GitRepository` service; without one this is a no-op.
   */
  readonly verifyGit?: boolean | undefined
  /**
   * Mask likely secrets in event content and in session title and metadata. A heuristic:
   * it reduces exposure, it cannot guarantee nothing sensitive remains.
   */
  readonly redact?: boolean | undefined
}

/** Enrichers for a read, with redaction last so it also covers derived events. */
const enrichersOf = (options: ReadOptions | undefined): ReadonlyArray<SessionEnricher> => [
  ...(options?.enrichers ?? []),
  ...(options?.redact === true ? [redactionEnricher] : [])
]

export interface WatchOptions {
  /** How often the source is checked for changes. Default 1 second. */
  readonly interval?: Duration.Input | undefined
}

export interface BridgeShape {
  readonly harnesses: {
    readonly list: ReadonlyArray<HarnessInfo>
    readonly detect: Effect.Effect<ReadonlyArray<DetectionResult>>
  }
  readonly sessions: {
    readonly list: (
      options?: ListSessionsOptions & { readonly harness?: string | undefined }
    ) => Stream.Stream<SessionDescriptor, BridgeError>
    readonly describe: (id: string) => Effect.Effect<SessionDescriptor, BridgeError>
    /** Load session metadata and import warnings. Reads the source once. */
    readonly get: (id: string, options?: { readonly redact?: boolean | undefined }) => Effect.Effect<LoadedSession, BridgeError>
    /** The canonical ordered event stream. */
    readonly events: (id: string, options?: ReadOptions) => Stream.Stream<SessionEvent, BridgeError>
    /**
     * Existing events, then new ones as the source grows, until interrupted.
     * History adapters are polled; see `WatchOptions`.
     */
    readonly watch: (id: string, options?: WatchOptions & ReadOptions) => Stream.Stream<SessionEvent, BridgeError>
    /** Write `<destination>/{manifest.json,session.json,events.jsonl}`. */
    readonly export: (id: string, destination: string, options?: ReadOptions) => Effect.Effect<ExportResult, BridgeError>
    /**
     * Import a session into the configured `SessionStore`. Skips the read when the store
     * already holds the session from an unchanged source, unless `force` is set.
     */
    readonly index: (id: string, options?: { readonly force?: boolean | undefined }) => Effect.Effect<IndexResult, BridgeError>
  }
}

export const sessionCapabilities = (capabilities: HarnessCapabilities): SessionCapabilities => ({
  history: capabilities.historicalSessions,
  live: capabilities.liveSessions,
  resume: capabilities.resumableSessions,
  toolCalls: capabilities.toolCalls,
  toolResults: capabilities.toolResults,
  reasoning: capabilities.reasoning,
  tokenUsage: capabilities.tokenUsage,
  fileEvents: capabilities.fileEvents,
  commandEvents: capabilities.commandEvents
})

export class Bridge extends Context.Service<Bridge, BridgeShape>()("@agentbridge/core/Bridge") {
  static readonly make = Effect.gen(function*() {
    const registry = yield* HarnessRegistry
    const store = yield* SessionStore
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const gitRepository = yield* Effect.serviceOption(GitRepository)
    const verifier = (descriptor: SessionDescriptor, options: ReadOptions | undefined) =>
      options?.verifyGit === true && Option.isSome(gitRepository)
        ? verifyGitCommit(gitRepository.value, descriptor.projectPath)
        : undefined
    const verifyStream = (descriptor: SessionDescriptor, options: ReadOptions | undefined) =>
    <E, R>(events: Stream.Stream<SessionEvent, E, R>): Stream.Stream<SessionEvent, E, R> => {
      const verify = verifier(descriptor, options)
      return verify === undefined ? events : events.pipe(Stream.mapEffect(verify))
    }

    const locate = (id: string): Effect.Effect<
      { readonly adapter: HarnessAdapterShape; readonly descriptor: SessionDescriptor },
      AdapterUnavailable | SessionNotFound | SessionReadError
    > =>
      Effect.gen(function*() {
        const adapter = yield* registry.forSession(id)
        const descriptor = yield* adapter.resolve(id as SessionId)
        return { adapter, descriptor }
      })

    const baseOf = (adapter: HarnessAdapterShape) => ({
      harness: { id: adapter.id, name: adapter.name },
      capabilities: sessionCapabilities(adapter.capabilities)
    })

    const get = (id: string, options?: { readonly redact?: boolean | undefined }) =>
      locate(id).pipe(
        Effect.flatMap(({ adapter, descriptor }) =>
          loadSession(descriptor, baseOf(adapter), adapter.read(descriptor)).pipe(
            Effect.tap((loaded) =>
              Effect.annotateCurrentSpan({
                harness: adapter.id,
                event_count: loaded.eventCount,
                warning_count: loaded.warnings.length
              })
            )
          )
        ),
        Effect.map((loaded) => (options?.redact === true ? { ...loaded, session: redactSession(loaded.session) } : loaded)),
        Effect.withSpan("bridge.load-session", { attributes: { session_id: id } })
      )

    const events = (id: string, options?: ReadOptions): Stream.Stream<SessionEvent, BridgeError> =>
      Stream.unwrap(
        Effect.map(locate(id), ({ adapter, descriptor }) =>
          adapter.read(descriptor).pipe(
            sequenceEvents(descriptor.id),
            enrichStream(enrichersOf(options)),
            verifyStream(descriptor, options)
          )
        )
      )

    /**
     * Follow a session as it grows. Append-only line sources (`adapter.follows`) are tailed from the
     * last byte offset through the same normalizer, so each poll costs only what was appended.
     * Other sources (a SQLite database, a JSON document rewritten in place) are re-read when their
     * file (or SQLite WAL) changes, emitting events past the last sequence seen; that is correct
     * because normalization is deterministic, and costs a full read per change.
     */
    const watch = (id: string, options?: WatchOptions & ReadOptions): Stream.Stream<SessionEvent, BridgeError> =>
      Stream.unwrap(Effect.gen(function*() {
        const { adapter, descriptor } = yield* locate(id)
        if (!adapter.capabilities.historicalSessions) {
          return Stream.fail(new CapabilityNotSupported({ sessionId: descriptor.id, capability: "watch" })) as Stream.Stream<SessionEvent, BridgeError>
        }
        const interval = options?.interval ?? "1 second"
        if (adapter.follows === true) {
          return adapter.read(descriptor, { follow: interval }).pipe(
            sequenceEvents(descriptor.id),
            enrichStream(enrichersOf(options)),
            verifyStream(descriptor, options)
          ) as Stream.Stream<SessionEvent, BridgeError>
        }
        const fingerprint = Effect.forEach([descriptor.sourcePath, `${descriptor.sourcePath}-wal`], (file) =>
          fs.stat(file).pipe(
            Effect.map((info) => `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`),
            Effect.orElseSucceed(() => "-")
          )).pipe(Effect.map((parts) => parts.join("|")))
        let seen: string | undefined
        let next = 0
        const poll = Stream.unwrap(Effect.map(fingerprint, (current) => {
          if (current === seen) return Stream.empty
          seen = current
          return adapter.read(descriptor).pipe(
            sequenceEvents(descriptor.id),
            Stream.filter((event) => event.sequence >= next),
            Stream.tap((event) => Effect.sync(() => { next = event.sequence + 1 }))
          )
        }))
        return poll.pipe(
          Stream.repeat(Schedule.spaced(interval)),
          enrichStream(enrichersOf(options)),
          verifyStream(descriptor, options)
        )
      }))

    // One emission pass supplies both the session fold and the event consumer.
    const consumeSession = <E>(
      adapter: HarnessAdapterShape,
      descriptor: SessionDescriptor,
      consume: (events: ReadonlyArray<SessionEvent>) => Effect.Effect<void, E>
    ) => Effect.suspend(() => {
      let sequence = 0
      return loadSession(descriptor, baseOf(adapter), adapter.read(descriptor).pipe(
        Stream.grouped(512),
        Stream.tap((batch) => consume(batch.flatMap((emission): Array<SessionEvent> =>
          emission._tag === "Event" ? [{ ...emission.event, sessionId: descriptor.id, sequence: sequence++ }] : []
        ))),
        Stream.flatMap(Stream.fromIterable)
      ))
    })

    const exportSession = (id: string, destination: string, options?: ReadOptions) =>
      Effect.gen(function*() {
        const { adapter, descriptor } = yield* locate(id)
        const fail = (cause: unknown) =>
          new ExportError({ sessionId: id, destination, message: describeCause(cause) })
        const ensureEmpty = Effect.gen(function*() {
          if (yield* fs.exists(destination)) {
            const entries = yield* fs.readDirectory(destination)
            if (entries.length > 0) return yield* fail("Destination is not empty; choose a new directory")
          }
        })
        yield* ensureEmpty.pipe(Effect.mapError(fail))
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(Effect.mapError(fail))
        const staging = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(destination), prefix: ".bridge-export-" }).pipe(Effect.mapError(fail))
        const bundle = path.join(staging, "bundle")
        yield* fs.makeDirectory(bundle).pipe(Effect.mapError(fail))
        const eventsPath = path.join(bundle, "events.jsonl")
        yield* fs.writeFileString(eventsPath, "").pipe(Effect.mapError(fail))
        const enrich = enrichment(enrichersOf(options))
        const verify = verifier(descriptor, options)
        let eventCount = 0
        const loaded = yield* consumeSession(adapter, descriptor, (raw) =>
          Effect.gen(function*() {
            const enriched = raw.flatMap(enrich)
            const batch = verify === undefined ? enriched : yield* Effect.forEach(enriched, verify)
            eventCount += batch.length
            if (batch.length > 0) {
              yield* fs.writeFileString(eventsPath, batch.map((event) => `${encodeEventLine(event)}\n`).join(""), { flag: "a" }).pipe(Effect.mapError(fail))
            }
          }))

        const manifest: BridgeSessionManifest = {
          format: "bridge-session",
          version: PROTOCOL_VERSION,
          sessionId: loaded.session.id,
          harness: loaded.session.harness.id,
          eventCount,
          warningCount: loaded.warnings.length
        }
        yield* fs.writeFileString(path.join(bundle, "session.json"), `${encodeSessionJson(options?.redact === true ? redactSession(loaded.session) : loaded.session)}\n`)
          .pipe(Effect.mapError(fail))
        yield* fs.writeFileString(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
          .pipe(Effect.mapError(fail))
        // Rename a complete directory on the same filesystem. Never overwrite user files.
        yield* ensureEmpty.pipe(Effect.mapError(fail))
        yield* fs.rename(bundle, destination).pipe(Effect.mapError(fail))
        return { directory: destination, manifest }
      }).pipe(Effect.scoped, Effect.withSpan("bridge.export-session", { attributes: { session_id: id } }))

    const index = (id: string, options?: { readonly force?: boolean | undefined }): Effect.Effect<IndexResult, BridgeError | StoreError> =>
      Effect.gen(function*() {
        const { adapter, descriptor } = yield* locate(id)
        const fingerprint = sourceFingerprint(descriptor)
        if (options?.force !== true && Option.getOrUndefined(yield* store.getFingerprint(descriptor.id)) === fingerprint) {
          const session = yield* store.getSession(descriptor.id)
          if (Option.isSome(session)) {
            return {
              session: session.value,
              warnings: yield* store.getWarnings(descriptor.id),
              eventCount: yield* Stream.runCount(store.events(descriptor.id)),
              skipped: true
            }
          }
        }
        const all: Array<SessionEvent> = []
        const loaded = yield* consumeSession(adapter, descriptor, (batch) => Effect.sync(() => { all.push(...batch) }))
        // Events first: a session row with a fingerprint promises its events are stored.
        yield* store.putEvents(loaded.session.id, all)
        yield* store.putSession(loaded.session, loaded.warnings, fingerprint)
        return { ...loaded, skipped: false }
      }).pipe(Effect.withSpan("bridge.store-session", { attributes: { session_id: id } }))

    const bridge: BridgeShape = {
      harnesses: {
        list: registry.adapters.map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          capabilities: adapter.capabilities
        })),
        detect: registry.detect
      },
      sessions: {
        list: (options) => registry.listSessions(options).pipe(Stream.withSpan("bridge.list-sessions")),
        describe: (id) => Effect.map(locate(id), ({ descriptor }) => descriptor),
        get,
        events,
        watch,
        export: exportSession,
        index
      }
    }
    return bridge
  })

  static readonly layer = Layer.effect(Bridge, Bridge.make)
}
