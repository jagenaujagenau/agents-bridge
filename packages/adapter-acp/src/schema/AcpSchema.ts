import { Schema } from "effect"

/**
 * The subset of Agent Client Protocol v1 that Bridge normalizes: `session/update`
 * notifications, `session/prompt` requests and their responses. Lenient like the
 * protocol itself (`x-deserialize-default-on-error`): unknown fields are ignored.
 */

export const AcpContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  uri: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resource: Schema.optionalKey(Schema.Struct({ uri: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }))
})
export type AcpContentBlock = typeof AcpContentBlock.Type

export const AcpToolCallContent = Schema.Struct({
  type: Schema.String,
  content: Schema.optionalKey(AcpContentBlock),
  path: Schema.optionalKey(Schema.String),
  oldText: Schema.optionalKey(Schema.NullOr(Schema.String)),
  newText: Schema.optionalKey(Schema.String),
  terminalId: Schema.optionalKey(Schema.String)
})
export type AcpToolCallContent = typeof AcpToolCallContent.Type

const ToolFields = {
  toolCallId: Schema.String,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  content: Schema.optionalKey(Schema.NullOr(Schema.Array(AcpToolCallContent))),
  locations: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ path: Schema.String })))),
  rawInput: Schema.optionalKey(Schema.Unknown),
  rawOutput: Schema.optionalKey(Schema.Unknown)
}

const ChunkFields = {
  content: AcpContentBlock,
  messageId: Schema.optionalKey(Schema.NullOr(Schema.String))
}

export const AcpUserMessageChunk = Schema.Struct({ sessionUpdate: Schema.tag("user_message_chunk"), ...ChunkFields })
export const AcpAgentMessageChunk = Schema.Struct({ sessionUpdate: Schema.tag("agent_message_chunk"), ...ChunkFields })
export const AcpAgentThoughtChunk = Schema.Struct({ sessionUpdate: Schema.tag("agent_thought_chunk"), ...ChunkFields })
export const AcpToolCall = Schema.Struct({ sessionUpdate: Schema.tag("tool_call"), ...ToolFields })
export const AcpToolCallUpdate = Schema.Struct({ sessionUpdate: Schema.tag("tool_call_update"), ...ToolFields })
export const AcpPlan = Schema.Struct({
  sessionUpdate: Schema.tag("plan"),
  entries: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      status: Schema.optionalKey(Schema.String),
      priority: Schema.optionalKey(Schema.String)
    })
  )
})
export const AcpSessionInfoUpdate = Schema.Struct({
  sessionUpdate: Schema.tag("session_info_update"),
  title: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const AcpSessionUpdate = Schema.Union([
  AcpUserMessageChunk,
  AcpAgentMessageChunk,
  AcpAgentThoughtChunk,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpPlan,
  AcpSessionInfoUpdate
])
export type AcpSessionUpdate = typeof AcpSessionUpdate.Type

export const KNOWN_UPDATES: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "session_info_update"
])

/** Updates about client UI state with no canonical meaning. */
export const IGNORED_UPDATES: ReadonlySet<string> = new Set([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "usage_update"
])

export const AcpPromptParams = Schema.Struct({
  sessionId: Schema.String,
  prompt: Schema.Array(AcpContentBlock)
})

export const AcpPromptResult = Schema.Struct({ stopReason: Schema.String })
