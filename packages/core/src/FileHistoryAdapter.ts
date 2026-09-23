import {
  type DetectionResult,
  type HarnessCapabilities,
  type HarnessId,
  makeSessionId,
  parseSessionId,
  type SessionDescriptor,
  type SessionId
} from "@agentbridge/schema"
import { Effect, FileSystem, Option, Path, Stream } from "effect"
import { SessionNotFound, type SessionReadError } from "./errors.ts"
import type { HarnessAdapterShape, ListSessionsOptions } from "./HarnessAdapter.ts"
import { HostEnvironment } from "./HostEnvironment.ts"
import type { Emission } from "./normalize.ts"
import { cacheDiscovery, isWithinProject, findExecutable, listFilesRecursive, readHeadLines, statFile, toIso } from "./sources.ts"
import { VersionProbe } from "./VersionProbe.ts"

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectOptions {
  readonly harness: HarnessId
  readonly name: string
  /** Executable names to look for on PATH. */
  readonly executables: ReadonlyArray<string>
  /** Install locations GUI launches often miss from PATH. */
  readonly extraDirs: ReadonlyArray<string>
  /** Paths whose existence means history is available. */
  readonly historyPaths: ReadonlyArray<string>
  /** Arguments that make the executable print its version. */
  readonly versionArgs?: ReadonlyArray<string>
}

/**
 * Shared detection: executable on PATH, version probe, history presence.
 * Never fails and never reads file contents, so credentials are never touched.
 */
export const detectHarness = (options: DetectOptions) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const probe = yield* VersionProbe
    const notes: Array<string> = []

    let historyPath: string | undefined
    for (const candidate of options.historyPaths) {
      const exists = yield* fs.exists(candidate).pipe(
        Effect.catch((error) => Effect.sync(() => (notes.push(`cannot access ${candidate}: ${error.message}`), false)))
      )
      if (exists) {
        historyPath = candidate
        break
      }
    }

    let executable = Option.none<string>()
    for (const name of options.executables) {
      executable = yield* findExecutable(fs, path, name, { pathEnv: host.pathEnv, extraDirs: options.extraDirs })
      if (Option.isSome(executable)) break
    }
    const version = Option.isSome(executable)
      ? yield* probe.probe(executable.value, options.versionArgs ?? ["--version"])
      : Option.none<string>()

    const result: DetectionResult = {
      harness: options.harness,
      name: options.name,
      installed: Option.isSome(executable),
      ...(Option.isSome(version) ? { version: version.value } : {}),
      historyAvailable: historyPath !== undefined,
      paths: [
        ...(historyPath !== undefined ? [historyPath] : []),
        ...(Option.isSome(executable) ? [executable.value] : [])
      ],
      notes
    }
    return result
  }).pipe(Effect.withSpan("bridge.detect", { attributes: { harness: options.harness } }))

/** Common per-user install directories, given a home directory. */
export const commonBinDirs = (path: Path.Path, home: string | undefined): ReadonlyArray<string> =>
  [
    ...(home === undefined ? [] : [path.join(home, ".local", "bin"), path.join(home, "bin")]),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ]

// ---------------------------------------------------------------------------
// File-per-session history adapters
// ---------------------------------------------------------------------------

/** What the path alone says about a session file. */
export interface FileCandidate {
  readonly path: string
  readonly nativeId?: string | undefined
  readonly parentNativeId?: string | undefined
  readonly agentLabel?: string | undefined
}

/** What a cheap look inside the file adds. Path-derived facts win over these. */
export interface HeadFacts {
  readonly nativeId?: string | undefined
  readonly parentNativeId?: string | undefined
  readonly agentLabel?: string | undefined
  readonly projectPath?: string | undefined
  readonly startedAt?: string | undefined
}

export interface FileHistoryAdapterOptions {
  readonly id: HarnessId
  readonly name: string
  readonly capabilities: HarnessCapabilities
  readonly detect: Omit<DetectOptions, "harness" | "name">
  /** Directories walked recursively for session files. Missing roots are empty. */
  readonly roots: ReadonlyArray<string>
  /** Map a file (path parts relative to its root) to a candidate, or `undefined` if it is not a session. */
  readonly classify: (relativeParts: ReadonlyArray<string>, absolute: string, root: string) => FileCandidate | undefined
  /** Lines read from the head of each file for `inspect`. 0 skips the read. */
  readonly headLines: number
  readonly inspect?: (head: ReadonlyArray<string>, candidate: FileCandidate) => HeadFacts
  /** Extra per-file facts that need I/O (sidecars, project maps). Failures should resolve to `{}`. */
  readonly enrich?: (candidate: FileCandidate) => Effect.Effect<HeadFacts>
  /** Cheap pre-filter for `resolve`: can this candidate be the session with this native ID? */
  readonly mayBe?: (candidate: FileCandidate, nativeId: string) => boolean
  /** When several files classify to the same native ID, the highest priority wins. */
  readonly priority?: (candidate: FileCandidate) => number
  readonly read: (descriptor: SessionDescriptor) => Stream.Stream<Emission, SessionReadError>
}

/**
 * Builds the discovery, listing and resolution half of an adapter for harnesses
 * that keep one file per session. The adapter supplies classification and the
 * normalizer; the walking, stat-ing and descriptor assembly are shared.
 */
export const makeFileHistoryAdapter = (options: FileHistoryAdapterOptions) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const detectContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | HostEnvironment | VersionProbe>()
    const harness = options.id

    const candidates = Effect.gen(function*() {
      const all: Array<FileCandidate> = []
      const byNativeId = new Map<string, number>()
      for (const root of options.roots) {
        const files = yield* listFilesRecursive(fs, path, harness, root)
        for (const absolute of files) {
          const candidate = options.classify(path.relative(root, absolute).split(path.sep), absolute, root)
          if (!candidate) continue
          const existing = candidate.nativeId === undefined ? undefined : byNativeId.get(candidate.nativeId)
          if (existing === undefined) {
            if (candidate.nativeId !== undefined) byNativeId.set(candidate.nativeId, all.length)
            all.push(candidate)
          } else if ((options.priority?.(candidate) ?? 0) > (options.priority?.(all[existing]!) ?? 0)) {
            all[existing] = candidate
          }
        }
      }
      return all
    })

    const discovery = yield* cacheDiscovery(candidates)

    const describe = (candidate: FileCandidate): Effect.Effect<Option.Option<SessionDescriptor>, SessionReadError> =>
      Effect.gen(function*() {
        const info = yield* statFile(fs, harness, candidate.path)
        const head = options.headLines > 0 ? yield* readHeadLines(fs, harness, candidate.path, options.headLines) : []
        const inspected = options.inspect?.(head, candidate) ?? {}
        const enriched = options.enrich ? yield* options.enrich(candidate) : {}
        const facts = { ...enriched, ...inspected }
        const nativeId = candidate.nativeId ?? facts.nativeId
        if (nativeId === undefined) return Option.none()
        const parentNativeId = candidate.parentNativeId ?? facts.parentNativeId
        const agentLabel = candidate.agentLabel ?? facts.agentLabel
        const updatedAt = toIso(info.modifiedAt)
        const startedAt = facts.startedAt
        const descriptor: SessionDescriptor = {
          id: makeSessionId(harness, nativeId),
          harness,
          nativeId,
          sourcePath: candidate.path,
          sizeBytes: info.sizeBytes,
          ...(facts.projectPath !== undefined ? { projectPath: facts.projectPath } : {}),
          ...(parentNativeId !== undefined ? { parentSessionId: makeSessionId(harness, parentNativeId) } : {}),
          ...(parentNativeId !== undefined && agentLabel !== undefined ? { agentLabel } : {}),
          ...(startedAt !== undefined && !Number.isNaN(Date.parse(startedAt))
            ? { startedAt: new Date(startedAt).toISOString() }
            : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {})
        }
        return Option.some(descriptor)
      })

    const listSessions = (listOptions?: ListSessionsOptions) =>
      Stream.fromEffect(listOptions?.refresh ? discovery.refresh : discovery.get).pipe(
        Stream.flatMap((all) => Stream.fromIterable(all)),
        Stream.mapEffect(describe, { concurrency: 8 }),
        Stream.flatMap((descriptor) => (Option.isSome(descriptor) ? Stream.succeed(descriptor.value) : Stream.empty)),
        Stream.filter((d) =>
          (listOptions?.since === undefined ||
            (d.updatedAt !== undefined && Date.parse(d.updatedAt) >= listOptions.since.getTime())) &&
          (listOptions?.projectPath === undefined || isWithinProject(path, d.projectPath, listOptions.projectPath))
        )
      )

    const resolve = (id: SessionId) =>
      Effect.gen(function*() {
        const parsed = parseSessionId(id)
        if (parsed === undefined || parsed.harness !== harness) return yield* new SessionNotFound({ sessionId: id })
        for (const candidate of yield* discovery.get) {
          const plausible = candidate.nativeId !== undefined
            ? candidate.nativeId === parsed.nativeId
            : options.mayBe?.(candidate, parsed.nativeId) ?? true
          if (!plausible) continue
          const descriptor = yield* describe(candidate)
          if (Option.isSome(descriptor) && descriptor.value.id === id) return descriptor.value
        }
        return yield* new SessionNotFound({ sessionId: id })
      })

    const adapter: HarnessAdapterShape = {
      id: harness,
      name: options.name,
      capabilities: options.capabilities,
      detect: detectHarness({ ...options.detect, harness, name: options.name }).pipe(Effect.provideContext(detectContext)),
      listSessions,
      resolve: (id) => resolve(id).pipe(Effect.catchTag("SessionNotFound", () => Effect.andThen(discovery.invalidate, resolve(id)))),
      read: (descriptor) =>
        options.read(descriptor).pipe(Stream.withSpan("bridge.normalize-session", { attributes: { harness } }))
    }
    return adapter
  })

/** Resolve a harness root: an override variable if set, else a path under the home directory. */
export const harnessRoot = (override: string, ...homeRelative: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const host = yield* HostEnvironment
    const path = yield* Path.Path
    const explicit = yield* host.variable(override)
    return explicit ?? path.join(host.home ?? ".", ...homeRelative)
  })
