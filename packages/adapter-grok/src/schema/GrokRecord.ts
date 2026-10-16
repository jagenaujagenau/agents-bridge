import { Schema } from "effect"

/**
 * Provider schemas for xAI Grok Build session history:
 * `${GROK_HOME:-~/.grok}/sessions/<encoded-cwd>/<session-id>/updates.jsonl` plus the
 * `summary.json` index entry beside it.
 *
 * `updates.jsonl` is the file Grok documents as "the authoritative conversation log that
 * drives /resume and session restore": one ACP `session/update` notification per line,
 * wrapped in an envelope with a receive time and per-line `_meta`:
 *
 * ```json
 * {"timestamp":1767261600.5,"method":"_x.ai/session/update",
 *  "params":{"sessionId":"…","update":{"sessionUpdate":"agent_message_chunk",…},
 *            "_meta":{"eventId":"…","agentTimestampMs":1767261600500,"promptId":"…"}}}
 * ```
 *
 * The sibling `chat_history.jsonl` ("raw chat messages sent to the model") repeats the
 * same conversation in model-request form and is deliberately not read (rule 5).
 *
 * Shapes follow Grok CLI 1.0.60's bundled documentation and serde field names, plus the
 * envelope seen by independent readers of the same files. Deliberately lenient: unknown
 * keys are ignored and every field is optional unless the update is meaningless without it.
 */

// ---------------------------------------------------------------------------
// ACP content
// ---------------------------------------------------------------------------

export const ContentBlock = Schema.Struct({
  /** Missing on some recorded chunks; a block with `text` is treated as text. */
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  uri: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resource: Schema.optionalKey(Schema.Struct({ uri: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }))
})
export type ContentBlock = typeof ContentBlock.Type

export const ToolCallContent = Schema.Struct({
  type: Schema.String,
  content: Schema.optionalKey(Schema.NullOr(ContentBlock)),
  path: Schema.optionalKey(Schema.String),
  oldText: Schema.optionalKey(Schema.NullOr(Schema.String)),
  newText: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export type ToolCallContent = typeof ToolCallContent.Type

const Meta = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)))

// ---------------------------------------------------------------------------
// Session updates (ACP v1 plus xAI extensions)
// ---------------------------------------------------------------------------

const ChunkFields = {
  content: ContentBlock,
  messageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  _meta: Meta
}

export const UserMessageChunk = Schema.Struct({ sessionUpdate: Schema.tag("user_message_chunk"), ...ChunkFields })
export const AgentMessageChunk = Schema.Struct({ sessionUpdate: Schema.tag("agent_message_chunk"), ...ChunkFields })
export const AgentThoughtChunk = Schema.Struct({ sessionUpdate: Schema.tag("agent_thought_chunk"), ...ChunkFields })

const ToolFields = {
  toolCallId: Schema.String,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** ACP tool kind (`read`, `edit`, `execute`, …), set by Grok itself. */
  kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** `pending`, `in_progress`, `completed`, `failed`; Grok also writes `cancelled` and `error`. */
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  content: Schema.optionalKey(Schema.NullOr(Schema.Array(ToolCallContent))),
  locations: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ path: Schema.String })))),
  rawInput: Schema.optionalKey(Schema.Unknown),
  rawOutput: Schema.optionalKey(Schema.Unknown),
  /** xAI addition in Grok's streamed form of the same update; read when present. */
  toolName: Schema.optionalKey(Schema.String),
  /** `x.ai/tool` carries Grok's canonical tool metadata. */
  _meta: Meta
}

export const ToolCall = Schema.Struct({ sessionUpdate: Schema.tag("tool_call"), ...ToolFields })
export const ToolCallUpdate = Schema.Struct({ sessionUpdate: Schema.tag("tool_call_update"), ...ToolFields })

export const Plan = Schema.Struct({
  sessionUpdate: Schema.tag("plan"),
  entries: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      status: Schema.optionalKey(Schema.String),
      priority: Schema.optionalKey(Schema.String)
    })
  )
})

export const SessionInfoUpdate = Schema.Struct({
  sessionUpdate: Schema.tag("session_info_update"),
  title: Schema.optionalKey(Schema.NullOr(Schema.String))
})

/** xAI extension: the end of one prompt's run, with token totals for that run. */
export const TurnCompleted = Schema.Struct({
  sessionUpdate: Schema.tag("turn_completed"),
  prompt_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** ACP stop reason in snake_case: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. */
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Totals for the whole run (`modelCalls` model calls), not per model call. */
  usage: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)))
})

/** xAI extension: automatic context compaction finished. */
export const AutoCompactCompleted = Schema.Struct({
  sessionUpdate: Schema.tag("auto_compact_completed"),
  tokens_before: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tokens_after: Schema.optionalKey(Schema.NullOr(Schema.Number))
})

export const GrokUpdate = Schema.Union([
  UserMessageChunk,
  AgentMessageChunk,
  AgentThoughtChunk,
  ToolCall,
  ToolCallUpdate,
  Plan,
  SessionInfoUpdate,
  TurnCompleted,
  AutoCompactCompleted
])
export type GrokUpdate = typeof GrokUpdate.Type

// ---------------------------------------------------------------------------
// The line envelope
// ---------------------------------------------------------------------------

export const GrokLine = Schema.Struct({
  /** Receive time: Unix seconds (fractional), or an ISO string in some writers. */
  timestamp: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.Struct({
    /** The session that produced the update. Not used for identity (rule 8). */
    sessionId: Schema.optionalKey(Schema.String),
    update: GrokUpdate,
    /** `eventId` (stable per line), `agentTimestampMs`, `promptId`, `promptIndex`, `streamStartMs`, `modelId`. */
    _meta: Meta
  })
})
export type GrokLine = typeof GrokLine.Type

/** The record type of a line: its `sessionUpdate`. */
export const updateTypeOf = (json: unknown): string | undefined => {
  if (typeof json !== "object" || json === null) return undefined
  const params = (json as { params?: unknown }).params
  if (typeof params !== "object" || params === null) return undefined
  const update = (params as { update?: unknown }).update
  if (typeof update !== "object" || update === null) return undefined
  const type = (update as { sessionUpdate?: unknown }).sessionUpdate
  return typeof type === "string" ? type : undefined
}

export const KNOWN_UPDATES: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "session_info_update",
  "turn_completed",
  "auto_compact_completed"
])

/**
 * Updates with no canonical meaning: client UI state, progress and runtime status. ACP's own
 * UI updates, plus xAI extension variants named in Grok 1.0.60's `SessionUpdate` enum whose
 * content is status only. Anything else surfaces as `unknown_record_type`.
 */
export const IGNORED_UPDATES: ReadonlySet<string> = new Set([
  // ACP
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "usage_update",
  // xAI: progress, status and UI state
  "tool_call_delta_chunk",
  "retry_state",
  "backend_responsive",
  "relay_sync_status",
  "session_status",
  "hooks_changed",
  "plugins_changed",
  "plugin_updates_installed",
  "project_trusted",
  "auto_compact_started",
  "auto_compact_failed",
  "auto_compact_cancelled",
  "memory_flush_started",
  "memory_flush_completed",
  "memory_dream_queued",
  "memory_dream_started",
  "memory_dream_completed",
  "memory_session_saved",
  "subagent_progress",
  "session_summary_generated",
  "session_recap",
  "session_recap_unavailable",
  "reasoning_completed",
  "response_completed"
])

// ---------------------------------------------------------------------------
// summary.json
// ---------------------------------------------------------------------------

/** The index entry beside `updates.jsonl`. Only display and linkage fields are read. */
export const GrokSummary = Schema.Struct({
  info: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    cwd: Schema.optionalKey(Schema.String)
  }))),
  generated_title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  session_summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title_is_manual: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  updated_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  current_model_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  head_branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The source session of a fork or restore, or the spawning session of a subagent. */
  parent_session_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  session_kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subagent_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_name: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export type GrokSummary = typeof GrokSummary.Type
