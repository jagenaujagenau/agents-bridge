import { Schema } from "effect"

/**
 * Provider schemas for Goose (github.com/block/goose).
 *
 * Current history lives in `<data>/sessions/sessions.db` (schema version ≤ 17):
 * `sessions` (one row per session) and `messages` (one row per `Message`, whose
 * `content_json` is the serde form of `Vec<MessageContent>` and `metadata_json` the
 * serde form of `MessageMetadata`). Goose before 1.10 wrote one
 * `<data>/sessions/<id>.jsonl` per session: a metadata line, then one `Message` per line.
 *
 * Only the columns Bridge needs are selected. `sessions.extension_data`,
 * `model_config_json` (may carry provider request headers), `recipe_json` and
 * `user_recipe_values_json` are never read, nor are `config.yaml` / `secrets.yaml`.
 */

const Annotations = Schema.Struct({
  audience: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
})

export const TextBlock = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  annotations: Schema.optionalKey(Schema.NullOr(Annotations))
})

/** `toolRequest.toolCall` / `toolResponse.toolResult`: `{status: "success", value}` or `{status: "error", error}`. */
const ToolOutcome = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown)
})

/** A model tool call. `frontendToolRequest` (≤ 1.x desktop) has the same shape. */
export const ToolRequestBlock = Schema.Struct({
  type: Schema.Literals(["toolRequest", "frontendToolRequest"]),
  id: Schema.String,
  toolCall: ToolOutcome
})
export type ToolRequestBlock = typeof ToolRequestBlock.Type

export const ToolResponseBlock = Schema.Struct({
  type: Schema.tag("toolResponse"),
  id: Schema.String,
  toolResult: ToolOutcome
})
export type ToolResponseBlock = typeof ToolResponseBlock.Type

export const ThinkingBlock = Schema.Struct({
  type: Schema.tag("thinking"),
  thinking: Schema.String
})

/** Pre-1.0 reasoning blocks; Goose itself migrates them to `thinking` on load. */
export const ReasoningBlock = Schema.Struct({
  type: Schema.tag("reasoning"),
  text: Schema.String
})

export const SystemNotificationBlock = Schema.Struct({
  type: Schema.tag("systemNotification"),
  notificationType: Schema.optionalKey(Schema.String),
  msg: Schema.String
})

export const ErrorBlock = Schema.Struct({
  type: Schema.tag("error"),
  kind: Schema.optionalKey(Schema.String),
  message: Schema.String
})

/** Older UI-only markers written into the conversation. */
export const LegacyNoticeBlock = Schema.Struct({
  type: Schema.Literals(["contextLengthExceeded", "summarizationRequested", "conversationCompacted"]),
  msg: Schema.optionalKey(Schema.String)
})

export const GooseBlock = Schema.Union([
  TextBlock,
  ToolRequestBlock,
  ToolResponseBlock,
  ThinkingBlock,
  ReasoningBlock,
  SystemNotificationBlock,
  ErrorBlock,
  LegacyNoticeBlock
])
export type GooseBlock = typeof GooseBlock.Type

export const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "toolRequest",
  "frontendToolRequest",
  "toolResponse",
  "thinking",
  "reasoning",
  "systemNotification",
  "error",
  "contextLengthExceeded",
  "summarizationRequested",
  "conversationCompacted"
])

/**
 * Blocks with no canonical meaning: inline base64 images and documents (no URI to point at),
 * redacted reasoning (never reconstructed), and approval / elicitation prompts.
 */
export const IGNORED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "image",
  "document",
  "redactedThinking",
  "toolConfirmationRequest",
  "actionRequired",
  "enableExtensionRequest"
])

/** Per-model-call usage Goose attaches to the call's last assistant message. */
export const MessageUsage = Schema.Struct({
  /** All prompt tokens, cache reads and writes included. */
  inputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  outputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  totalTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cacheReadTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cacheWriteTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  isCompaction: Schema.optionalKey(Schema.Boolean)
})

export const MessageMetadata = Schema.Struct({
  /** Shown in the UI. `false` marks text Goose added for the model only. */
  userVisible: Schema.optionalKey(Schema.Boolean),
  /** Sent to the model. `false` marks history kept after compaction, and UI-only notices. */
  agentVisible: Schema.optionalKey(Schema.Boolean),
  /** A per-turn `<turn-context>` block appended by the agent. */
  turnContext: Schema.optionalKey(Schema.Boolean),
  /** A message injected into a running turn. */
  steer: Schema.optionalKey(Schema.Boolean),
  usage: Schema.optionalKey(Schema.NullOr(MessageUsage)),
  inference: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    provider: Schema.optionalKey(Schema.String),
    requestedModel: Schema.optionalKey(Schema.String),
    resolvedModel: Schema.optionalKey(Schema.NullOr(Schema.String))
  })))
})
export type MessageMetadata = typeof MessageMetadata.Type

/** A `Message` line of a legacy JSONL session. */
export const LegacyMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  role: Schema.String,
  created: Schema.optionalKey(Schema.Number),
  content: Schema.Array(Schema.Unknown),
  metadata: Schema.optionalKey(Schema.Unknown)
})

/** Line 1 of a legacy JSONL session. */
export const LegacySessionHeader = Schema.Struct({
  working_dir: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Schema.String)
})

/** A session row, as selected by the adapter (columns absent from older schemas are `null`). */
export interface SessionRow {
  readonly id: string
  readonly name: string | null
  readonly description: string | null
  readonly session_type: string | null
  readonly working_dir: string | null
  readonly created_at: string | number | null
  readonly updated_at: string | number | null
  readonly parent_session_id: string | null
  readonly provider_name: string | null
}

/** A message row, as selected by the adapter. */
export interface MessageRow {
  readonly id: number
  readonly message_id: string | null
  readonly role: string
  readonly content_json: string
  readonly created_timestamp: number | null
  readonly metadata_json: string | null
}
