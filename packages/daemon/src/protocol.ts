import { BackendUnavailable, type BridgeError, BridgeErrorSchema, gitEnricher, type ReadOptions } from "@agentbridge/core"
import { Duration, Option, Schema } from "effect"

/**
 * The daemon's HTTP protocol. Plain JSON and JSONL over a Unix socket: canonical
 * events and sessions travel in their wire format, errors as encoded `BridgeError`s.
 * Both the server and the `DaemonBridge` client use only this module to agree.
 */

export const DAEMON_PROTOCOL = 1

export const routes = {
  health: "/v1/health",
  shutdown: "/v1/shutdown",
  harnesses: "/v1/harnesses",
  detect: "/v1/harnesses/detect",
  sessions: "/v1/sessions",
  describe: "/v1/session/describe",
  session: "/v1/session",
  events: "/v1/session/events",
  watch: "/v1/session/watch",
  export: "/v1/session/export",
  index: "/v1/session/index"
} as const

export interface Health {
  readonly protocol: number
  readonly pid: number
  readonly startedAt: string
  readonly watches: number
}

// ---------------------------------------------------------------------------
// Read options over the wire
// ---------------------------------------------------------------------------

/**
 * The server-side part of `ReadOptions`. Enrichers are functions and cannot travel; the
 * built-in git enricher is sent as a flag because verification must follow it on the
 * server. Other enrichers are applied by the client after the stream arrives.
 */
export interface WireReadOptions {
  readonly git: boolean
  readonly verifyGit: boolean
  readonly redact: boolean
}

export const wireReadOptions = (options: ReadOptions | undefined): WireReadOptions => ({
  git: options?.enrichers?.includes(gitEnricher) ?? false,
  verifyGit: options?.verifyGit === true,
  redact: options?.redact === true
})

export const localEnrichers = (options: ReadOptions | undefined) =>
  (options?.enrichers ?? []).filter((enricher) => enricher !== gitEnricher)

export const toSearchParams = (values: Readonly<Record<string, string | number | boolean | undefined>>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === false) continue
    params.set(key, value === true ? "1" : String(value))
  }
  return params
}

export const readOptionsFrom = (params: URLSearchParams): ReadOptions => ({
  enrichers: params.get("git") === "1" ? [gitEnricher] : [],
  verifyGit: params.get("verifyGit") === "1",
  redact: params.get("redact") === "1"
})

export const intervalMillis = (input: Duration.Input | undefined): number | undefined =>
  input === undefined ? undefined : Option.getOrUndefined(Option.map(Duration.fromInput(input), Duration.toMillis))

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const encodeError = Schema.encodeSync(BridgeErrorSchema)
const decodeError = Schema.decodeUnknownOption(BridgeErrorSchema)

/** HTTP status for a Bridge failure: missing things are 404, bad requests 400, the rest 500. */
export const statusOf = (error: BridgeError): number => {
  switch (error._tag) {
    case "SessionNotFound":
    case "AdapterUnavailable":
    case "HarnessNotInstalled":
      return 404
    case "CapabilityNotSupported":
    case "UnsupportedSessionVersion":
    case "ExportError":
      return 400
    default:
      return 500
  }
}

export const errorBody = (error: BridgeError) => JSON.stringify({ error: encodeError(error) })

/** Read an `{ error }` body back into a typed `BridgeError`. */
export const errorFrom = (json: unknown): BridgeError => {
  const encoded = typeof json === "object" && json !== null && "error" in json ? json.error : undefined
  return Option.getOrElse(
    decodeError(encoded),
    () => new BackendUnavailable({ message: `Unreadable daemon error: ${JSON.stringify(json).slice(0, 200)}` })
  )
}

/** Stream lines that are not events: a terminal `{ "error": … }`. */
export const isErrorLine = (json: unknown): json is { readonly error: unknown } =>
  typeof json === "object" && json !== null && "error" in json && !("type" in json)
