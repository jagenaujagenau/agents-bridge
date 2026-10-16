import { Schema } from "effect"

/**
 * Provider schemas for pi (`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`).
 * Entries form a tree through `id`/`parentId`; the file is append-only.
 */

const Entry = {
  id: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  timestamp: Schema.optionalKey(Schema.String)
}

export const PiSessionHeader = Schema.Struct({
  type: Schema.tag("session"),
  id: Schema.String,
  version: Schema.optionalKey(Schema.Number),
  timestamp: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  parentSession: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const PiModelChange = Schema.Struct({
  type: Schema.tag("model_change"),
  ...Entry,
  provider: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String)
})

export const PiCompaction = Schema.Struct({
  type: Schema.tag("compaction"),
  ...Entry,
  summary: Schema.optionalKey(Schema.String)
})

export const PiBranchSummary = Schema.Struct({
  type: Schema.tag("branch_summary"),
  ...Entry,
  summary: Schema.optionalKey(Schema.String)
})

export const PiSessionInfo = Schema.Struct({
  type: Schema.tag("session_info"),
  ...Entry,
  name: Schema.optionalKey(Schema.NullOr(Schema.String))
})

/** A model call outside the conversation (e.g. a prompt-cache warm-up). pi 1.0+. */
export const PiUsageEntry = Schema.Struct({
  type: Schema.tag("usage"),
  ...Entry,
  kind: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(Schema.Unknown)
})

export const PiCustomMessage = Schema.Struct({
  type: Schema.tag("custom_message"),
  ...Entry,
  content: Schema.optionalKey(Schema.Unknown)
})

export const TextBlock = Schema.Struct({ type: Schema.tag("text"), text: Schema.String })
export const ThinkingBlock = Schema.Struct({ type: Schema.tag("thinking"), thinking: Schema.String })
export const ImageBlock = Schema.Struct({
  type: Schema.tag("image"),
  mimeType: Schema.optionalKey(Schema.String)
})
export const ToolCallBlock = Schema.Struct({
  type: Schema.tag("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown)
})
export const PiBlock = Schema.Union([TextBlock, ThinkingBlock, ImageBlock, ToolCallBlock])
export type PiBlock = typeof PiBlock.Type

export const PiUserMessage = Schema.Struct({
  role: Schema.tag("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
})

export const PiAssistantMessage = Schema.Struct({
  role: Schema.tag("assistant"),
  content: Schema.Array(Schema.Unknown),
  model: Schema.optionalKey(Schema.String),
  stopReason: Schema.optionalKey(Schema.String),
  errorMessage: Schema.optionalKey(Schema.String),
  /** `{ input, output, cacheRead, cacheWrite, reasoning? }`; read leniently by `usageOf`. */
  usage: Schema.optionalKey(Schema.Unknown)
})

export const PiToolResultMessage = Schema.Struct({
  role: Schema.tag("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  isError: Schema.optionalKey(Schema.Boolean),
  /** Tool-specific; interpreted only by the dialect's tool table. */
  details: Schema.optionalKey(Schema.Unknown)
})

/** pi 1.0+: the system prompt sent to the model, with its sections and tool definitions. */
export const PiSystemMessage = Schema.Struct({
  role: Schema.tag("system"),
  content: Schema.optionalKey(Schema.Unknown)
})

/** A shell command the user ran with `!cmd` (`!!cmd` keeps it out of model context). */
export const PiBashExecutionMessage = Schema.Struct({
  role: Schema.tag("bashExecution"),
  command: Schema.String,
  output: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cancelled: Schema.optionalKey(Schema.Boolean)
})

/** Extension-injected message (`custom`; `hookMessage` before session format v3). */
export const PiCustomRoleMessage = Schema.Struct({
  role: Schema.Literals(["custom", "hookMessage"]),
  content: Schema.optionalKey(Schema.Unknown)
})

export const PiMessage = Schema.Union([
  PiUserMessage,
  PiAssistantMessage,
  PiToolResultMessage,
  PiSystemMessage,
  PiBashExecutionMessage,
  PiCustomRoleMessage
])
export type PiMessage = typeof PiMessage.Type

export const PiMessageEntry = Schema.Struct({
  type: Schema.tag("message"),
  ...Entry,
  message: PiMessage
})

export const PiRecord = Schema.Union([
  PiSessionHeader,
  PiModelChange,
  PiCompaction,
  PiBranchSummary,
  PiSessionInfo,
  PiUsageEntry,
  PiCustomMessage,
  PiMessageEntry
])
export type PiRecord = typeof PiRecord.Type

export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "session",
  "model_change",
  "compaction",
  "branch_summary",
  "session_info",
  "usage",
  "custom_message",
  "message"
])

/**
 * Entries that carry UI or extension state only. `context_edit` (pi 1.0) rewrites what an earlier
 * entry contributes to model context; the entry it targets still records what happened.
 */
export const METADATA_TYPES: ReadonlySet<string> = new Set(["thinking_level_change", "custom", "label", "context_edit"])
