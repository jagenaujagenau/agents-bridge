import {
  BackendUnavailable,
  Bridge,
  type BridgeError,
  type BridgeShape,
  describeCause,
  enrichStream,
  type HarnessInfo,
  type IndexResult
} from "@agentbridge/core"
import {
  BridgeSessionManifest,
  DetectionResult,
  HarnessCapabilities,
  HarnessId,
  ImportWarning,
  Session,
  SessionDescriptor,
  SessionEvent
} from "@agentbridge/schema"
import { Effect, Layer, Option, Path, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { NodeHttpClient } from "@effect/platform-node"
import { Agent } from "undici"
import {
  errorFrom,
  type Health,
  intervalMillis,
  isErrorLine,
  localEnrichers,
  routes,
  toSearchParams,
  wireReadOptions
} from "./protocol.ts"

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) => {
  const run = Schema.decodeUnknownEffect(schema as unknown as Schema.Codec<S["Type"], unknown>)
  return (value: unknown): Effect.Effect<S["Type"], BridgeError> =>
    run(value).pipe(Effect.mapError((cause) => new BackendUnavailable({ message: `Unreadable ${what} from daemon: ${describeCause(cause)}` })))
}

const decodeSession = decode(Session, "session")
const decodeDescriptor = decode(SessionDescriptor, "session descriptor")
const decodeEvent = decode(SessionEvent, "event")
const decodeExport = decode(Schema.Struct({ directory: Schema.String, manifest: BridgeSessionManifest }), "export result")
const decodeWarnings = decode(Schema.Array(ImportWarning), "warnings")
const decodeDetected = decode(Schema.Array(DetectionResult), "detection results")
const decodeHarnesses = decode(
  Schema.Array(Schema.Struct({ id: HarnessId, name: Schema.String, capabilities: HarnessCapabilities })),
  "harness list"
)

const unavailable = (cause: unknown) => new BackendUnavailable({ message: `Bridge daemon unreachable: ${describeCause(cause)}` })

export interface DaemonBridgeOptions {
  /** The daemon's Unix socket. */
  readonly socket: string
}

/**
 * `Bridge` backed by a running daemon (spec §71): the same `BridgeShape` as the embedded
 * backend, so applications switch deployment mode by swapping this layer.
 */
export const make = Effect.gen(function*() {
  const client = yield* HttpClient.HttpClient
  const path = yield* Path.Path

  const url = (route: string, params?: URLSearchParams) =>
    `http://bridge.daemon${route}${params && [...params].length > 0 ? `?${params}` : ""}`

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(Effect.mapError(unavailable))

  const readJson = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.mapError(unavailable))

  /** One JSON response; non-2xx answers carry an encoded `BridgeError`. */
  const call = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function*() {
      const response = yield* send(request)
      const json = yield* readJson(response)
      return response.status >= 200 && response.status < 300 ? json : yield* Effect.fail(errorFrom(json))
    }).pipe(Effect.scoped)

  /** A JSONL response, decoded line by line; a trailing `{ error }` line fails the stream. */
  const lines = <A>(request: HttpClientRequest.HttpClientRequest, decodeLine: (value: unknown) => Effect.Effect<A, BridgeError>) =>
    Stream.unwrap(Effect.gen(function*() {
      const response = yield* send(request)
      if (response.status < 200 || response.status >= 300) return Stream.fail(errorFrom(yield* readJson(response)))
      return response.stream.pipe(
        Stream.mapError(unavailable),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.mapEffect((line) => {
          const json = (() => {
            try {
              return JSON.parse(line) as unknown
            } catch {
              return undefined
            }
          })()
          if (json === undefined) return Effect.fail(new BackendUnavailable({ message: "Malformed line from daemon" }))
          return isErrorLine(json) ? Effect.fail(errorFrom(json)) : decodeLine(json)
        })
      )
    }))

  const withSession = (json: unknown) =>
    Effect.gen(function*() {
      const value = json as { session: unknown; warnings: unknown; eventCount: number; skipped?: boolean }
      return {
        session: yield* decodeSession(value.session),
        warnings: yield* decodeWarnings(value.warnings),
        eventCount: value.eventCount
      }
    })

  const list = yield* Effect.flatMap(call(HttpClientRequest.get(url(routes.harnesses))), decodeHarnesses).pipe(
    Effect.map((harnesses): ReadonlyArray<HarnessInfo> => harnesses)
  )

  const bridge: BridgeShape = {
    harnesses: {
      list,
      detect: Effect.flatMap(call(HttpClientRequest.get(url(routes.detect))), decodeDetected).pipe(
        // `detect` never fails in-process; an unreachable daemon detects nothing.
        Effect.orElseSucceed(() => [])
      )
    },
    sessions: {
      list: (options) =>
        lines(
          HttpClientRequest.get(url(routes.sessions, toSearchParams({
            harness: options?.harness,
            project: options?.projectPath,
            since: options?.since?.toISOString(),
            refresh: options?.refresh === true
          }))),
          decodeDescriptor
        ),
      describe: (id) => Effect.flatMap(call(HttpClientRequest.get(url(routes.describe, toSearchParams({ id })))), decodeDescriptor),
      get: (id, options) =>
        Effect.flatMap(call(HttpClientRequest.get(url(routes.session, toSearchParams({ id, redact: options?.redact === true })))), withSession),
      events: (id, options) =>
        lines(HttpClientRequest.get(url(routes.events, toSearchParams({ id, ...wireReadOptions(options) }))), decodeEvent).pipe(
          enrichStream(localEnrichers(options))
        ),
      watch: (id, options) =>
        lines(
          HttpClientRequest.get(url(routes.watch, toSearchParams({ id, interval: intervalMillis(options?.interval), ...wireReadOptions(options) }))),
          decodeEvent
        ).pipe(enrichStream(localEnrichers(options))),
      export: (id, destination, options) =>
        call(HttpClientRequest.post(url(routes.export)).pipe(
          // The daemon resolves nothing against its own working directory.
          HttpClientRequest.bodyJsonUnsafe({ id, destination: path.resolve(destination), ...wireReadOptions(options) })
        )).pipe(Effect.flatMap(decodeExport)),
      index: (id, options) =>
        Effect.flatMap(
          call(HttpClientRequest.post(url(routes.index)).pipe(HttpClientRequest.bodyJsonUnsafe({ id, force: options?.force === true }))),
          (json) => Effect.map(withSession(json), (loaded): IndexResult => ({ ...loaded, skipped: (json as { skipped: boolean }).skipped }))
        )
    }
  }
  return bridge
})

/** An HTTP client whose every connection goes to the daemon's Unix socket. */
export const socketClient = (socket: string) =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(
    Layer.provide(Layer.effect(NodeHttpClient.Dispatcher, Effect.acquireRelease(
      Effect.sync(() => new Agent({ connect: { socketPath: socket } })),
      (agent) => Effect.promise(() => agent.close())
    )))
  )

export const DaemonBridge = {
  make,
  /** Requires `Path`. Construction fails with `BackendUnavailable` when no daemon answers. */
  layer: (options: DaemonBridgeOptions) =>
    Layer.effect(Bridge, make).pipe(Layer.provide(socketClient(options.socket)))
}

/** The daemon's health, or `None` when nothing answers on the socket. */
export const daemonHealth = (socket: string): Effect.Effect<Option.Option<Health>> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(`http://bridge.daemon${routes.health}`)
    return Option.some((yield* response.json) as unknown as Health)
  }).pipe(
    Effect.scoped,
    Effect.provide(socketClient(socket)),
    Effect.timeoutOption("2 seconds"),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<Health>())
  )

/** Ask a running daemon to stop. Succeeds with whether one was running. */
export const stopDaemon = (socket: string): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    yield* client.execute(HttpClientRequest.post(`http://bridge.daemon${routes.shutdown}`))
    return true
  }).pipe(Effect.scoped, Effect.provide(socketClient(socket)), Effect.orElseSucceed(() => false))

/** Default socket: `$BRIDGE_SOCKET`, else `~/.bridge/daemon.sock`. */
export const defaultSocket = (env: Readonly<Record<string, string | undefined>>, home: string) =>
  env["BRIDGE_SOCKET"] ?? `${home}/.bridge/daemon.sock`
