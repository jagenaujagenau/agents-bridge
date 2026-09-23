import { Schema } from "effect"

/**
 * Public identifiers. All of them are branded strings in memory and plain
 * strings on the wire.
 */

export const SessionId = Schema.String.pipe(
  Schema.brand("SessionId"),
  Schema.annotate({
    description: "Canonical session ID: `<harnessId>:<nativeId>`, subagents `<harnessId>:<parentNativeId>/<suffix>`."
  })
)
export type SessionId = typeof SessionId.Type

export const EventId = Schema.String.pipe(
  Schema.brand("EventId"),
  Schema.annotate({ description: "Deterministic event ID, see docs/protocol.md#stable-event-ids." })
)
export type EventId = typeof EventId.Type

export const HarnessId = Schema.String.pipe(Schema.brand("HarnessId"))
export type HarnessId = typeof HarnessId.Type

export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"))
export type CommandId = typeof CommandId.Type

export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type

export const RelationshipId = Schema.String.pipe(Schema.brand("RelationshipId"))
export type RelationshipId = typeof RelationshipId.Type

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/

/** Calendar-aware RFC 3339 validation. Leap seconds are not supported by the runtime. */
export const isTimestamp = (value: string): boolean => {
  const m = timestampPattern.exec(value)
  if (!m) return false
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! &&
    Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60 &&
    (m[8] === "Z" || (Number(m[9]) < 24 && Number(m[10]) < 60))
}

/** RFC 3339 timestamp string. The canonical wire time format. */
export const Timestamp = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isTimestamp, {
    expected: "a valid RFC 3339 calendar timestamp (without leap seconds)",
    toJsonSchema: () => ({ pattern: timestampPattern.source, format: "date-time" })
  })),
  Schema.annotate({ description: "RFC 3339 timestamp, UTC recommended." })
)
export type Timestamp = typeof Timestamp.Type

/**
 * Build the canonical session ID. The only place that knows the shape.
 */
export const makeSessionId = (harness: string, nativeId: string): SessionId =>
  `${harness}:${nativeId}` as SessionId

/**
 * Split a canonical session ID into its harness and native parts.
 * Returns `undefined` for strings that are not canonical session IDs.
 */
export const parseSessionId = (
  id: string
): { readonly harness: HarnessId; readonly nativeId: string } | undefined => {
  const index = id.indexOf(":")
  if (index <= 0 || index === id.length - 1) return undefined
  return { harness: id.slice(0, index) as HarnessId, nativeId: id.slice(index + 1) }
}
