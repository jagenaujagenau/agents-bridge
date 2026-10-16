import { Schema } from "effect"

/**
 * Provider schemas for Crush (charmbracelet/crush), which keeps one SQLite database per
 * project at `<data_directory>/crush.db` (default `<project>/.crush/crush.db`).
 *
 * Only the `sessions` and `messages` tables are read. `files` holds full snapshots of every
 * file the agent touched (which may include secrets such as `.env`) and is never queried;
 * neither are `read_files` or the MCP tables.
 *
 * `messages.parts` is a JSON array of `{ "type": <tag>, "data": <payload> }`, written by
 * `marshalParts` in internal/message/message.go. Payload keys follow the Go JSON tags;
 * `BinaryContent` has no tags, so its keys are the Go field names.
 */

/** `TextContent`. `hidden` marks a generated continuation (e.g. "Implement the plan."). */
export const TextPart = Schema.Struct({
  type: Schema.tag("text"),
  data: Schema.Struct({
    text: Schema.String,
    hidden: Schema.optionalKey(Schema.Boolean)
  })
})

/** `ReasoningContent`; `started_at` / `finished_at` are Unix seconds. */
export const ReasoningPart = Schema.Struct({
  type: Schema.tag("reasoning"),
  data: Schema.Struct({
    thinking: Schema.String,
    started_at: Schema.optionalKey(Schema.Number),
    finished_at: Schema.optionalKey(Schema.Number)
  })
})

/** `ImageURLContent`. */
export const ImageUrlPart = Schema.Struct({
  type: Schema.tag("image_url"),
  data: Schema.Struct({ url: Schema.String, detail: Schema.optionalKey(Schema.String) })
})

/** `BinaryContent` (an attachment). `Data` is base64 and is never decoded. */
export const BinaryPart = Schema.Struct({
  type: Schema.tag("binary"),
  data: Schema.Struct({
    Path: Schema.optionalKey(Schema.NullOr(Schema.String)),
    MIMEType: Schema.optionalKey(Schema.NullOr(Schema.String))
  })
})

/** `ToolCall`. `input` is the arguments as a JSON-encoded string. */
export const ToolCallPart = Schema.Struct({
  type: Schema.tag("tool_call"),
  data: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    input: Schema.optionalKey(Schema.String),
    provider_executed: Schema.optionalKey(Schema.Boolean),
    finished: Schema.optionalKey(Schema.Boolean)
  })
})
export type ToolCallPart = typeof ToolCallPart.Type

/** `ToolResult`, carried by `tool`-role messages. `metadata` is a JSON-encoded string. */
export const ToolResultPart = Schema.Struct({
  type: Schema.tag("tool_result"),
  data: Schema.Struct({
    tool_call_id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(Schema.String),
    mime_type: Schema.optionalKey(Schema.String),
    is_error: Schema.optionalKey(Schema.Boolean)
  })
})
export type ToolResultPart = typeof ToolResultPart.Type

/**
 * `Finish`: how a model call ended (`end_turn`, `tool_use`, `max_tokens`, `canceled`,
 * `error`, `content_filter`, `unknown`). `time` is Unix seconds. Crush also appends a
 * `stop` finish with time 0 to every user and tool message; those carry no meaning.
 */
export const FinishPart = Schema.Struct({
  type: Schema.tag("finish"),
  data: Schema.Struct({
    reason: Schema.String,
    time: Schema.optionalKey(Schema.Number),
    message: Schema.optionalKey(Schema.String),
    details: Schema.optionalKey(Schema.String)
  })
})

/** `ShellCommand`: a bang-mode (`!cmd`) command the user ran, stored as a user message. */
export const ShellCommandPart = Schema.Struct({
  type: Schema.tag("shell_command"),
  data: Schema.Struct({
    command: Schema.String,
    output: Schema.optionalKey(Schema.String),
    exit_code: Schema.optionalKey(Schema.Number)
  })
})

export const CrushPart = Schema.Union([
  TextPart,
  ReasoningPart,
  ImageUrlPart,
  BinaryPart,
  ToolCallPart,
  ToolResultPart,
  FinishPart,
  ShellCommandPart
])
export type CrushPart = typeof CrushPart.Type

export const KNOWN_PART_TYPES: ReadonlySet<string> = new Set([
  "text",
  "reasoning",
  "image_url",
  "binary",
  "tool_call",
  "tool_result",
  "finish",
  "shell_command"
])

export const IGNORED_PART_TYPES: ReadonlySet<string> = new Set()

/**
 * The global project registry, `projects.json` in Crush's global data directory
 * (internal/projects). Crush registers every working directory it starts in, with the
 * data directory it resolved for it.
 */
export const ProjectRegistry = Schema.Struct({
  projects: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Struct({
      path: Schema.optionalKey(Schema.String),
      data_dir: Schema.optionalKey(Schema.String)
    })))
  )
})

/** A session row, as selected by the adapter. Times are Unix seconds. */
export interface SessionRow {
  readonly id: string
  readonly parent_session_id: string | null
  readonly title: string | null
  readonly prompt_tokens: number | null
  readonly completion_tokens: number | null
  readonly cost: number | null
  readonly created_at: number | null
  readonly updated_at: number | null
}

/** A message row, as selected by the adapter. Times are Unix seconds. */
export interface MessageRow {
  readonly id: string
  readonly role: string
  readonly parts: string
  readonly model: string | null
  readonly provider: string | null
  readonly created_at: number | null
  readonly is_summary_message: number | null
}
