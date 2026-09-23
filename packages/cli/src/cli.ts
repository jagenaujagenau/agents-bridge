import { Bridge, type BridgeError, gitEnricher } from "@agentbridge/core"
import { encodeEventLine, encodeSessionJson, PROTOCOL_VERSION, type SessionDescriptor, type SessionEvent } from "@agentbridge/schema"
import { defaultSocket, daemonHealth, runDaemon, stopDaemon } from "@agentbridge/daemon"
import { Console, Effect, Option, Schedule, Stream } from "effect"
import { spawn } from "node:child_process"
import { mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { renderDescriptorRow, renderDetection, renderEvent, renderSession } from "./render.ts"

const json = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print machine-readable JSON"))
const redact = Flag.Boolean("redact").pipe(Flag.withDefault(false), Flag.withDescription("Mask likely secrets (heuristic; not a guarantee)"))
const git = Flag.Boolean("git").pipe(Flag.withDefault(false), Flag.withDescription("Derive git.commit events from git commit commands and verify them in the project repository"))
const readOptions = (options: { readonly redact: boolean; readonly git: boolean }) => ({
  enrichers: options.git ? [gitEnricher] : [],
  verifyGit: options.git,
  redact: options.redact
})


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

const show = Command.make("show", { json, sessionId, redact }, ({ json, redact, sessionId }) =>
  reportErrors(Effect.gen(function*() {
    const bridge = yield* Bridge
    const loaded = yield* bridge.sessions.get(sessionId, { redact })
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

const printEvent = (jsonl: boolean) => (event: SessionEvent) => {
  if (jsonl) return Console.log(encodeEventLine(event))
  const line = renderEvent(event)
  return line === undefined ? Effect.void : Console.log(line)
}

const events = Command.make("events", { sessionId, jsonl, redact, git }, ({ jsonl, sessionId, ...options }) =>
  reportErrors(Effect.gen(function*() {
    const bridge = yield* Bridge
    yield* bridge.sessions.events(sessionId, readOptions(options)).pipe(Stream.runForEach(printEvent(jsonl)))
  }))).pipe(Command.withDescription("Stream a session's canonical events"))

const watch = Command.make("watch", { sessionId, jsonl, redact, git }, ({ jsonl, sessionId, ...options }) =>
  reportErrors(Effect.gen(function*() {
    const bridge = yield* Bridge
    yield* bridge.sessions.watch(sessionId, readOptions(options)).pipe(Stream.runForEach(printEvent(jsonl)))
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
      const result = yield* bridge.sessions.export(sessionId, destination, readOptions(options))
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

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

const socketFlag = Flag.String("socket").pipe(
  Flag.optional,
  Flag.withDescription("Unix socket (default $BRIDGE_SOCKET or ~/.bridge/daemon.sock)")
)
const socketOf = (flag: Option.Option<string>) => Option.getOrElse(flag, () => defaultSocket(process.env, homedir()))

const daemonStart = Command.make(
  "start",
  {
    socket: socketFlag,
    detach: Flag.Boolean("detach").pipe(Flag.withDefault(false), Flag.withDescription("Run in the background; log to ~/.bridge/daemon.log"))
  },
  ({ detach, socket: flag }) =>
    Effect.gen(function*() {
      const socket = socketOf(flag)
      const running = yield* daemonHealth(socket)
      if (Option.isSome(running)) {
        yield* Console.log(`bridge daemon already running (pid ${running.value.pid}) on ${socket}`)
        return
      }
      if (detach) {
        const log = join(dirname(socket), "daemon.log")
        mkdirSync(dirname(socket), { recursive: true, mode: 0o700 })
        const out = openSync(log, "a", 0o600)
        const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "daemon", "start", "--socket", socket], {
          detached: true,
          stdio: ["ignore", out, out]
        })
        child.unref()
        const health = yield* daemonHealth(socket).pipe(
          Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced("100 millis"), times: 100 })
        )
        if (Option.isNone(health)) {
          yield* Console.error(`bridge daemon did not start; see ${log}`)
          process.exitCode = 1
          return
        }
        yield* Console.log(`bridge daemon started (pid ${health.value.pid}) on ${socket}`)
        return
      }
      yield* Console.log(`bridge daemon listening on ${socket} (pid ${process.pid})`)
      yield* runDaemon({ socket })
      yield* Console.log("bridge daemon stopped")
    })
).pipe(Command.withDescription("Serve Bridge to other processes over a Unix socket"))

const daemonStop = Command.make("stop", { socket: socketFlag }, ({ socket: flag }) =>
  Effect.gen(function*() {
    const socket = socketOf(flag)
    yield* Console.log((yield* stopDaemon(socket)) ? "bridge daemon stopping" : `no bridge daemon on ${socket}`)
  })).pipe(Command.withDescription("Stop a running daemon"))

const daemonStatus = Command.make("status", { socket: socketFlag, json }, ({ json, socket: flag }) =>
  Effect.gen(function*() {
    const socket = socketOf(flag)
    const health = yield* daemonHealth(socket)
    if (json) return yield* Console.log(JSON.stringify(Option.getOrNull(health)))
    if (Option.isNone(health)) {
      yield* Console.log(`no bridge daemon on ${socket}`)
      process.exitCode = 1
      return
    }
    const h = health.value
    yield* Console.log(`bridge daemon running on ${socket}\n  pid: ${h.pid}\n  since: ${h.startedAt}\n  active watches: ${h.watches}\n  protocol: ${h.protocol}`)
  })).pipe(Command.withDescription("Show whether a daemon is running"))

const daemon = Command.make("daemon").pipe(
  Command.withDescription("Run Bridge as a background service shared by many clients"),
  Command.withSubcommands([daemonStart, daemonStop, daemonStatus])
)

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
  Command.withSubcommands([harnesses, sessions, show, events, watch, exportCommand, index, daemon, doctor])
)
