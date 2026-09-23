import { BackendUnavailable, Bridge, type BridgeError, type BridgeShape, describeCause, ExportError } from "@agentbridge/core"
import { encodeEventLine, encodeSessionJson, type SessionEvent, SessionDescriptor } from "@agentbridge/schema"
import { NodeHttpServer } from "@effect/platform-node"
import { Deferred, Effect, Exit, Layer, PubSub, RcMap, Schema, type Scope, Stream, type Take } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, isAbsolute } from "node:path"
import {
  DAEMON_PROTOCOL,
  errorBody,
  type Health,
  readOptionsFrom,
  routes,
  statusOf
} from "./protocol.ts"

const encodeDescriptor = Schema.encodeSync(SessionDescriptor)

const json = (value: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(value), { status, contentType: "application/json" })

const failure = (error: BridgeError) =>
  HttpServerResponse.text(errorBody(error), { status: statusOf(error), contentType: "application/json" })

/** Run a Bridge call and answer with its JSON result or its typed error. */
const respond = <A>(effect: Effect.Effect<A, BridgeError>, toJson: (a: A) => unknown = (a) => a) =>
  effect.pipe(Effect.match({ onFailure: failure, onSuccess: (a) => json(toJson(a)) }))

/**
 * JSONL response. A failure after the stream has started cannot change the status any
 * more, so it is sent as a final `{ "error": … }` line.
 */
const jsonl = <A>(stream: Stream.Stream<A, BridgeError>, line: (a: A) => string) =>
  HttpServerResponse.stream(
    stream.pipe(
      Stream.map((a) => `${line(a)}\n`),
      Stream.catch((error) => Stream.succeed(`${errorBody(error)}\n`)),
      Stream.encodeText
    ),
    { contentType: "application/x-ndjson" }
  )

const query = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://bridge.daemon").searchParams

const requiredId = (params: URLSearchParams) => {
  const id = params.get("id")
  return id === null || id.length === 0
    ? Effect.fail(new BackendUnavailable({ message: "Missing session id" }))
    : Effect.succeed(id)
}

const body = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(
    Effect.map((value) => (typeof value === "object" && value !== null ? value as Record<string, unknown> : {})),
    Effect.mapError((cause) => new BackendUnavailable({ message: `Invalid request body: ${describeCause(cause)}` }))
  )

/**
 * One watch per session and option set, shared by every subscriber (spec §70). The replay
 * buffer holds the events emitted so far, so a late subscriber gets the same stream as the
 * first: existing events, then new ones. The watch stops shortly after its last subscriber.
 */
// ponytail: replay keeps every event of a watched session in memory; bound it if very long sessions are watched for days.
const makeWatchHub = (bridge: BridgeShape) =>
  RcMap.make({
    lookup: (key: string) =>
      Effect.gen(function*() {
        const { id, interval, params } = JSON.parse(key) as { id: string; interval: number | undefined; params: string }
        const pubsub = yield* PubSub.unbounded<Take.Take<SessionEvent, BridgeError>>({ replay: Number.MAX_SAFE_INTEGER })
        yield* bridge.sessions.watch(id, { ...readOptionsFrom(new URLSearchParams(params)), ...(interval !== undefined ? { interval } : {}) }).pipe(
          Stream.runForEach((event) => PubSub.publish(pubsub, [event])),
          Effect.exit,
          Effect.flatMap((exit) => PubSub.publish(pubsub, Exit.asVoid(exit))),
          Effect.forkScoped
        )
        return pubsub
      }),
    idleTimeToLive: "2 seconds"
  })

const watchKey = (id: string, params: URLSearchParams) => {
  const interval = params.get("interval")
  const options = new URLSearchParams([...params].filter(([key]) => ["git", "verifyGit", "redact"].includes(key)).sort())
  return JSON.stringify({ id, interval: interval === null ? undefined : Number(interval), params: options.toString() })
}

const Routes = (shutdown: Deferred.Deferred<void>, startedAt: string) =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const hub = yield* makeWatchHub(bridge)
      let watches = 0

      yield* router.add("GET", routes.health, Effect.sync(() => {
        const health: Health = { protocol: DAEMON_PROTOCOL, pid: process.pid, startedAt, watches }
        return json(health)
      }))

      yield* router.add("POST", routes.shutdown, Effect.as(Deferred.succeed(shutdown, undefined), json({ stopping: true })))

      yield* router.add("GET", routes.harnesses, json(bridge.harnesses.list))

      yield* router.add("GET", routes.detect, Effect.map(bridge.harnesses.detect, (detected) => json(detected)))

      yield* router.add("GET", routes.sessions, (request) => {
        const params = query(request)
        const since = params.get("since")
        return Effect.succeed(jsonl(
          bridge.sessions.list({
            harness: params.get("harness") ?? undefined,
            projectPath: params.get("project") ?? undefined,
            since: since === null ? undefined : new Date(since),
            refresh: params.get("refresh") === "1"
          }),
          (descriptor) => JSON.stringify(encodeDescriptor(descriptor))
        ))
      })

      yield* router.add("GET", routes.describe, (request) =>
        respond(Effect.flatMap(requiredId(query(request)), bridge.sessions.describe), encodeDescriptor))

      yield* router.add("GET", routes.session, (request) => {
        const params = query(request)
        return respond(
          Effect.flatMap(requiredId(params), (id) => bridge.sessions.get(id, { redact: params.get("redact") === "1" })),
          (loaded) => ({ ...loaded, session: JSON.parse(encodeSessionJson(loaded.session)) })
        )
      })

      yield* router.add("GET", routes.events, (request) => {
        const params = query(request)
        return Effect.succeed(jsonl(
          Stream.unwrap(Effect.map(requiredId(params), (id) => bridge.sessions.events(id, readOptionsFrom(params)))),
          encodeEventLine
        ))
      })

      yield* router.add("GET", routes.watch, (request) => {
        const params = query(request)
        // The subscription (and the hub reference) live exactly as long as the response stream.
        const shared: Stream.Stream<SessionEvent, BridgeError> = Stream.unwrap(Effect.gen(function*() {
          const id = yield* requiredId(params)
          const pubsub = yield* RcMap.get(hub, watchKey(id, params))
          watches++
          yield* Effect.addFinalizer(() => Effect.sync(() => { watches-- }))
          return Stream.fromPubSubTake(pubsub)
        }))
        return Effect.succeed(jsonl(shared, encodeEventLine))
      })

      yield* router.add("POST", routes.export, (request) =>
        respond(Effect.gen(function*() {
          const input = yield* body(request)
          const id = typeof input["id"] === "string" ? input["id"] : ""
          const destination = typeof input["destination"] === "string" ? input["destination"] : ""
          // The daemon's working directory is not the caller's; only absolute destinations are unambiguous.
          if (!isAbsolute(destination)) {
            return yield* new ExportError({ sessionId: id, destination, message: "The daemon needs an absolute destination" })
          }
          return yield* bridge.sessions.export(id, destination, {
            ...readOptionsFrom(new URLSearchParams()),
            ...(input["git"] === true ? readOptionsFrom(new URLSearchParams("git=1")) : {}),
            verifyGit: input["verifyGit"] === true,
            redact: input["redact"] === true
          })
        })))

      yield* router.add("POST", routes.index, (request) =>
        respond(Effect.gen(function*() {
          const input = yield* body(request)
          const id = typeof input["id"] === "string" ? input["id"] : ""
          return yield* bridge.sessions.index(id, { force: input["force"] === true })
        }), (result) => ({ ...result, session: JSON.parse(encodeSessionJson(result.session)) })))
    })
  )

export interface DaemonOptions {
  /** Unix socket path. Its directory is created owner-only (0700). */
  readonly socket: string
}

/**
 * Start serving the `Bridge` from the context on a Unix socket. Returns once the socket is
 * listening, with a signal that completes when a client asks the daemon to stop; the server
 * closes with the surrounding scope. Access control is the filesystem: the socket is owner-only.
 */
export const serveDaemon = (options: DaemonOptions): Effect.Effect<Deferred.Deferred<void>, unknown, Bridge | Scope.Scope> =>
  Effect.gen(function*() {
    const shutdown = yield* Deferred.make<void>()
    mkdirSync(dirname(options.socket), { recursive: true, mode: 0o700 })
    // A socket file left by a crashed daemon blocks listen; callers check liveness before starting.
    if (existsSync(options.socket)) unlinkSync(options.socket)
    yield* Effect.addFinalizer(() => Effect.sync(() => { if (existsSync(options.socket)) unlinkSync(options.socket) }))
    yield* Layer.build(
      HttpRouter.serve(Routes(shutdown, new Date().toISOString()), { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => createServer(), { path: options.socket }))
      )
    )
    chmodSync(options.socket, 0o600)
    return shutdown
  })

/** Serve until a client asks the daemon to stop, or until interrupted. */
export const runDaemon = (options: DaemonOptions): Effect.Effect<void, unknown, Bridge> =>
  Effect.gen(function*() {
    const shutdown = yield* serveDaemon(options)
    yield* Deferred.await(shutdown)
    // Let the shutdown response flush before the server closes.
    yield* Effect.sleep("50 millis")
  }).pipe(Effect.scoped)
