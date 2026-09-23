import { Schema } from "effect"

/**
 * Provider schemas for OpenCode's SQLite store (`$XDG_DATA_HOME/opencode/opencode.db`).
 * Only the `session`, `message` and `part` tables are read; the database also holds
 * account and credential tables, which Bridge never queries.
 */

const Time = Schema.Struct({
  start: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  end: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  created: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  completed: Schema.optionalKey(Schema.NullOr(Schema.Number))
})

export const OpenCodeUserMessage = Schema.Struct({
  role: Schema.tag("user"),
  time: Schema.optionalKey(Time),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Struct({ modelID: Schema.optionalKey(Schema.String) }))
})

export const OpenCodeAssistantMessage = Schema.Struct({
  role: Schema.tag("assistant"),
  time: Schema.optionalKey(Time),
  modelID: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.Struct({ cwd: Schema.optionalKey(Schema.String) })),
  error: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      data: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
    }))
  )
})

export const OpenCodeMessage = Schema.Union([OpenCodeUserMessage, OpenCodeAssistantMessage])
export type OpenCodeMessage = typeof OpenCodeMessage.Type

export const TextPart = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  synthetic: Schema.optionalKey(Schema.Boolean),
  ignored: Schema.optionalKey(Schema.Boolean),
  time: Schema.optionalKey(Time)
})

export const ReasoningPart = Schema.Struct({
  type: Schema.tag("reasoning"),
  text: Schema.String,
  time: Schema.optionalKey(Time)
})

export const ToolPart = Schema.Struct({
  type: Schema.tag("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    input: Schema.optionalKey(Schema.Unknown),
    output: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    time: Schema.optionalKey(Time)
  })
})
export type ToolPart = typeof ToolPart.Type

export const FilePart = Schema.Struct({
  type: Schema.tag("file"),
  mime: Schema.optionalKey(Schema.String),
  filename: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Struct({ path: Schema.optionalKey(Schema.String) }))
})

export const CompactionPart = Schema.Struct({ type: Schema.tag("compaction") })

/** Ends one model call; carries that call's token usage. */
export const StepFinishPart = Schema.Struct({
  type: Schema.tag("step-finish"),
  tokens: Schema.optionalKey(Schema.Struct({
    input: Schema.optionalKey(Schema.Number),
    output: Schema.optionalKey(Schema.Number),
    reasoning: Schema.optionalKey(Schema.Number),
    cache: Schema.optionalKey(Schema.Struct({ read: Schema.optionalKey(Schema.Number), write: Schema.optionalKey(Schema.Number) }))
  }))
})

export const OpenCodePart = Schema.Union([TextPart, ReasoningPart, ToolPart, FilePart, CompactionPart, StepFinishPart])
export type OpenCodePart = typeof OpenCodePart.Type

export const KNOWN_PART_TYPES: ReadonlySet<string> = new Set(["text", "reasoning", "tool", "file", "compaction", "step-finish"])

/** Parts that track steps, snapshots or token accounting only. */
export const IGNORED_PART_TYPES: ReadonlySet<string> = new Set([
  "step-start",
  "patch",
  "snapshot",
  "agent",
  "subtask",
  "retry"
])

/** A session row, as selected by the adapter. */
export interface SessionRow {
  readonly id: string
  readonly parent_id: string | null
  readonly directory: string | null
  readonly title: string | null
  readonly version: string | null
  readonly agent: string | null
  readonly time_created: number | null
  readonly time_updated: number | null
}

/** One part joined to its message, as selected by the adapter. */
export interface PartRow {
  readonly message_id: string
  readonly message_data: string
  readonly part_id: string | null
  readonly part_data: string | null
}
