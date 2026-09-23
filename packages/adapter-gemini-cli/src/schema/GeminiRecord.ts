import { Schema } from "effect"

/**
 * Provider schemas for Gemini CLI chat recordings
 * (`~/.gemini/tmp/<project hash or name>/chats/session-<time>-<id>.json`).
 * One JSON document per chat, rewritten as the chat grows.
 */

export const GeminiThought = Schema.Struct({
  subject: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String)
})

export const GeminiToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  args: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  status: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  resultDisplay: Schema.optionalKey(Schema.Unknown)
})
export type GeminiToolCall = typeof GeminiToolCall.Type

const MessageFields = {
  id: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Unknown)
}

export const GeminiUserMessage = Schema.Struct({ type: Schema.tag("user"), ...MessageFields })

export const GeminiModelMessage = Schema.Struct({
  type: Schema.tag("gemini"),
  ...MessageFields,
  model: Schema.optionalKey(Schema.String),
  thoughts: Schema.optionalKey(Schema.Array(GeminiThought)),
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    input: Schema.optionalKey(Schema.Number),
    output: Schema.optionalKey(Schema.Number),
    cached: Schema.optionalKey(Schema.Number),
    thoughts: Schema.optionalKey(Schema.Number)
  }))),
  toolCalls: Schema.optionalKey(Schema.Array(GeminiToolCall))
})

export const GeminiNoticeMessage = Schema.Struct({
  type: Schema.Literals(["info", "warning", "error"]),
  ...MessageFields
})

export const GeminiMessage = Schema.Union([GeminiUserMessage, GeminiModelMessage, GeminiNoticeMessage])
export type GeminiMessage = typeof GeminiMessage.Type

export const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set(["user", "gemini", "info", "warning", "error"])

export const GeminiConversation = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  projectHash: Schema.optionalKey(Schema.String),
  startTime: Schema.optionalKey(Schema.String),
  lastUpdated: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  messages: Schema.Array(Schema.Unknown)
})

/** `resultDisplay` of file-writing tools. */
export const FileDiffDisplay = Schema.Struct({
  fileDiff: Schema.optionalKey(Schema.String),
  fileName: Schema.optionalKey(Schema.String),
  originalContent: Schema.optionalKey(Schema.NullOr(Schema.String))
})
