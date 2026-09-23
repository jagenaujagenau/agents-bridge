import { Bridge, type BridgeError, gitEnricher, redactionEnricher, type SessionEnricher } from "@agentbridge/core"
import { encodeEventLine, encodeSessionJson, PROTOCOL_VERSION, type SessionDescriptor, type SessionEvent } from "@agentbridge/schema"
import { Console, Effect, Option, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { renderDescriptorRow, renderDetection, renderEvent, renderSession } from "./render.ts"

const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print machine-readable JSON"))

const describeError = (error: BridgeError): string => {
  switch (error._tag) {
    case "SessionNotFound":
      return `session not found: ${error.sessionId}`
    case "CapabilityNotSupported":
      return `${error.sessionId} does not support ${error.capability} sessions yet`
    case "HarnessNotInstalled":
      return `harness not installed: ${error.harness}`
    case "UnsupportedSessionVersion":
      return `${error.harness} version ${error.version} is not supported`
    default:
      return `${error._tag}: ${error.message}`
  }
}

/** Expected failures print a one-line message and set a non-zero exit code instead of a stack trace. */
const reportErrors = <A, R>(effect: Effect.Effect<A, BridgeError, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Console.error(`error: ${describeError(error)}`).pipe(
        Effect.andThen(Effect.sync(() => {
          process.exitCode = 1
        }))
      )
    )
  )

const harnesses = Command.make("harnesses", { json }, ({ json }) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const detected = yield* bridge.harnesses.detect
    if (json) {
      const capabilities = new Map(bridge.harnesses.list.map(({ capabilities, id }) => [id, capabilities]))
      const rows = detected.map((d) => ({ ...d, capabilities: capabilities.get(d.harness) }))
      return yield* Console.log(JSON.stringify(rows, null, 2))
    }
    for (const d of detected) yield* Console.log(renderDetection(d))
  })).pipe(Command.withDescription("Detect installed harnesses and their history"))

const sessions = Command.make(
  "sessions",
  {
    json,
    harness: Flag.String("harness").pipe(Flag.optional, Flag.withDescription("Only this harness ID (see `bridge harnesses --json`)")),
    project: Flag.String("project").pipe(Flag.optional, Flag.withDescription("Only sessions under this path")),
    limit: Flag.Int("limit").pipe(Flag.withDefault(50), Flag.withDescription("Most recent N sessions (0 = all)"))
  },
  ({ harness, json, limit, project }) =>
    reportErrors(Effect.gen(function*() {
      const bridge = yield* Bridge
      const all = yield* Stream.runCollect(
        bridge.sessions.list({ harness: Option.getOrUndefined(harness), projectPath: Option.getOrUndefined(project) })
      )
      const byRecency = [...all].sort((a: SessionDescriptor, b: SessionDescriptor) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
      )
      const shown = limit > 0 ? byRecency.slice(0, limit) : byRecency
      if (json) return yield* Console.log(JSON.stringify(shown, null, 2))
      for (const d of shown) yield* Console.log(renderDescriptorRow(d))
      if (shown.length < all.length) yield* Console.log(`… ${all.length - shown.length} more (use --limit 0)`)
    }))
).pipe(Command.withDescription("List historical sessions from every detected harness"))

const sessionId = Argument.String("session-id").pipe(Argument.withDescription("Canonical session ID"))

const show = Command.make("show", { json, sessionId }, ({ json, sessionId }) =>
  reportErrors(Effect.gen(function*() {
    const bridge = yield* Bridge
    const loaded = yield* bridge.sessions.get(sessionId)
    if (json) {
      return yield* Console.log(JSON.stringify({
        session: JSON.parse(encodeSessionJson(loaded.session)),
        warnings: loaded.warnings,
        eventCount: loaded.eventCount
      }, null, 2))
    }
    yield* Console.log(renderSession(loaded.session, loaded.warnings, loaded.eventCount))
  }))).pipe(Command.withDescription("Show one session's metadata and import warnings"))

const jsonl = Flag.Boolean("jsonl").pipe(Flag.withDefault(false), Flag.withDescription("Print canonical events as JSONL"))

const redact = Flag.Boolean("redact").pipe(Flag.withDefault(false), Flag.withDescription("Mask likely secrets (heuristic; not a guarantee)"))
const git = Flag.Boolean("git").pipe(Flag.withDefault(false), Flag.withDescription("Derive git.commit events from git commit commands"))
const enrichers = (options: { readonly redact: boolean; readonly git: boolean }): Array<SessionEnricher> => [
  ...(options.git ? [gitEnricher] : []),
  ...(options.redact ? [redactionEnricher] : [])
]

const printEvent = (jsonl: boolean) => (event: SessionEvent) => {
  if (jsonl) return Console.log(encodeEventLine(event))
  const line = renderEvent(event)
  return line === undefined ? Effect.void : Console.log(line)
}

const events = Command.make("events", { sessionId, jsonl, redact, git }, ({ jsonl, sessionId, ...options }) =>
  reportErrors(Effect.gen(function*() {
    const bridge = yield* Bridge
    yield* bridge.sessions.events(sessionId, { enrichers: enrichers(options) }).pipe(Stream.runForEach(printEvent(jsonl)))
  }))).pipe(Command.withDescription("Stream a session's canonical events"))

const watch = Command.make("watch", { sessionId, jsonl, redact, git }, ({ jsonl, sessionId, ...options }) =>
  reportErrors(Effect.gen(function*() {
    const bridge = yield* Bridge
    yield* bridge.sessions.watch(sessionId, { enrichers: enrichers(options) }).pipe(Stream.runForEach(printEvent(jsonl)))
  }))).pipe(Command.withDescription("Stream a session's events, then follow new ones until interrupted"))

const exportCommand = Command.make(
  "export",
  {
    sessionId,
    out: Flag.String("out").pipe(Flag.optional, Flag.withDescription("Destination directory (default .bridge/<id>)")),
    redact,
    git
  },
  ({ out, sessionId, ...options }) =>
    reportErrors(Effect.gen(function*() {
      const bridge = yield* Bridge
      const destination = Option.getOrElse(out, () => `.bridge/${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_")}`)
      const result = yield* bridge.sessions.export(sessionId, destination, { enrichers: enrichers(options) })
      yield* Console.log(`exported ${result.manifest.eventCount} events to ${result.directory}`)
    }))
).pipe(Command.withDescription("Export a session as manifest.json + session.json + events.jsonl"))

const index = Command.make(
  "index",
  {
    harness: Flag.String("harness").pipe(Flag.optional, Flag.withDescription("Only this harness ID")),
    force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("Re-import unchanged sessions too"))
  },
  ({ force, harness }) =>
    reportErrors(Effect.gen(function*() {
      const bridge = yield* Bridge
      const totals = { indexed: 0, unchanged: 0, failed: 0, events: 0 }
      yield* bridge.sessions.list({ harness: Option.getOrUndefined(harness) }).pipe(
        Stream.runForEach((descriptor) =>
          bridge.sessions.index(descriptor.id, { force }).pipe(
            Effect.map((result) => {
              result.skipped ? totals.unchanged++ : totals.indexed++
              totals.events += result.eventCount
            }),
            Effect.catch((error) =>
              Console.error(`${descriptor.id}: ${describeError(error)}`).pipe(Effect.andThen(Effect.sync(() => { totals.failed++ })))
            )
          )
        )
      )
      yield* Console.log(`indexed ${totals.indexed}, unchanged ${totals.unchanged}, failed ${totals.failed} (${totals.events} events)`)
      if (totals.failed > 0) process.exitCode = 1
    }))
).pipe(Command.withDescription("Import sessions into the SQLite index ($BRIDGE_DB, default ~/.bridge/bridge.db)"))

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    yield* Console.log("Bridge Doctor\n")
    const detected = yield* bridge.harnesses.detect
    for (const d of detected) yield* Console.log(`${renderDetection(d)}\n`)
    for (const { id, name } of bridge.harnesses.list) {
      const counted = yield* bridge.sessions.list({ harness: id }).pipe(
        Stream.runCount,
        Effect.map((n) => `${n} sessions`),
        Effect.catch((error) => Effect.succeed(`listing failed: ${error._tag}`))
      )
      yield* Console.log(`${name}: ${counted}`)
    }
    yield* Console.log(`\nSchema version: ${PROTOCOL_VERSION}`)
    yield* Console.log(`Storage: SQLite index at ${process.env["BRIDGE_DB"] ?? "~/.bridge/bridge.db"} (written by \`bridge index\`)`)
  })).pipe(Command.withDescription("Diagnose harness detection and history access"))

export const bridge = Command.make("bridge").pipe(
  Command.withDescription("Bridge: one canonical model for coding-agent sessions"),
  Command.withSubcommands([harnesses, sessions, show, events, watch, exportCommand, index, doctor])
)
