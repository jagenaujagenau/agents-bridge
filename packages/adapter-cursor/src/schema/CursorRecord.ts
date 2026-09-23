import { Schema } from "effect"

/**
 * Provider schemas for Cursor agent transcripts
 * (`~/.cursor/projects/<encoded path>/agent-transcripts/<id>/<id>.jsonl`).
 *
 * Observed properties that shape the adapter: records carry no timestamps, no
 * record IDs, tool calls carry no call IDs, and tool results are not recorded.
 */

export const CursorTextBlock = Schema.Struct({ type: Schema.tag("text"), text: Schema.String })
export const CursorToolUseBlock = Schema.Struct({
  type: Schema.tag("tool_use"),
  name: Schema.String,
  input: Schema.optionalKey(Schema.Unknown)
})
export const CursorBlock = Schema.Union([CursorTextBlock, CursorToolUseBlock])
export type CursorBlock = typeof CursorBlock.Type

export const CursorMessageRecord = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]) })
})
export type CursorMessageRecord = typeof CursorMessageRecord.Type

export const CursorTurnEnded = Schema.Struct({
  type: Schema.tag("turn_ended"),
  status: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown)
})

export const CursorRecord = Schema.Union([CursorMessageRecord, CursorTurnEnded])
export type CursorRecord = typeof CursorRecord.Type

/** Records are typed by `role` (messages) or `type` (turn markers). */
export const cursorRecordType = (json: unknown): string | undefined => {
  if (typeof json !== "object" || json === null) return undefined
  const record = json as Record<string, unknown>
  if (typeof record["role"] === "string") return `role:${record["role"]}`
  if (typeof record["type"] === "string") return record["type"]
  return undefined
}

export const KNOWN_TYPES: ReadonlySet<string> = new Set(["role:user", "role:assistant", "turn_ended"])
