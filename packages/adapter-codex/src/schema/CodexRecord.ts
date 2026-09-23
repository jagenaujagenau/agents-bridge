import { Schema } from "effect"

/**
 * Provider schemas for Codex rollout files
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`).
 * Unknown keys are ignored so newer CLI versions keep decoding.
 */

export const RolloutLine = Schema.Struct({
  timestamp: Schema.optionalKey(Schema.String),
  type: Schema.String,
  payload: Schema.optionalKey(Schema.Unknown)
})

export const SessionMeta = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  originator: Schema.optionalKey(Schema.String),
  cli_version: Schema.optionalKey(Schema.String),
  model_provider: Schema.optionalKey(Schema.String),
  forked_from_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(Schema.Unknown),
  git: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({
      commit_hash: Schema.optionalKey(Schema.NullOr(Schema.String)),
      branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
      repository_url: Schema.optionalKey(Schema.NullOr(Schema.String))
    }))
  )
})
export type SessionMeta = typeof SessionMeta.Type

/** `source: {subagent: {thread_spawn: {parent_thread_id, agent_nickname}}}` */
export const SubagentSource = Schema.Struct({
  subagent: Schema.Struct({
    thread_spawn: Schema.Struct({
      parent_thread_id: Schema.String,
      agent_nickname: Schema.optionalKey(Schema.NullOr(Schema.String)),
      agent_role: Schema.optionalKey(Schema.NullOr(Schema.String))
    })
  })
})

export const TurnContext = Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  turn_id: Schema.optionalKey(Schema.String)
})

export const Compacted = Schema.Struct({ message: Schema.optionalKey(Schema.String) })

// ---------------------------------------------------------------------------
// response_item payloads: what the model saw
// ---------------------------------------------------------------------------

export const MessageItem = Schema.Struct({
  type: Schema.tag("message"),
  role: Schema.String,
  content: Schema.Array(Schema.Unknown)
})

export const ReasoningItem = Schema.Struct({
  type: Schema.tag("reasoning"),
  summary: Schema.optionalKey(Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))),
  content: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))))
})

export const FunctionCallItem = Schema.Struct({
  type: Schema.tag("function_call"),
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.String),
  call_id: Schema.String
})

export const CustomToolCallItem = Schema.Struct({
  type: Schema.tag("custom_tool_call"),
  name: Schema.String,
  input: Schema.optionalKey(Schema.String),
  call_id: Schema.String
})

export const LocalShellCallItem = Schema.Struct({
  type: Schema.tag("local_shell_call"),
  call_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  action: Schema.Struct({
    command: Schema.Array(Schema.String),
    working_directory: Schema.optionalKey(Schema.NullOr(Schema.String))
  })
})

export const FunctionCallOutputItem = Schema.Struct({
  type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
  call_id: Schema.String,
  output: Schema.optionalKey(Schema.Unknown)
})

export const WebSearchCallItem = Schema.Struct({
  type: Schema.tag("web_search_call"),
  action: Schema.optionalKey(Schema.Struct({ query: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
})

export const ToolSearchCallItem = Schema.Struct({
  type: Schema.tag("tool_search_call"),
  call_id: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown)
})

export const ToolSearchOutputItem = Schema.Struct({
  type: Schema.tag("tool_search_output"),
  call_id: Schema.String
})

export const ResponseItem = Schema.Union([
  MessageItem,
  ReasoningItem,
  FunctionCallItem,
  CustomToolCallItem,
  LocalShellCallItem,
  FunctionCallOutputItem,
  WebSearchCallItem,
  ToolSearchCallItem,
  ToolSearchOutputItem
])
export type ResponseItem = typeof ResponseItem.Type

export const RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "function_call_output",
  "custom_tool_call_output",
  "web_search_call",
  "tool_search_call",
  "tool_search_output"
])

/** Response items with no canonical meaning. */
export const IGNORED_RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set(["ghost_snapshot", "compaction_summary"])

// ---------------------------------------------------------------------------
// event_msg payloads: what the UI showed. Used only for facts response_item lacks.
// ---------------------------------------------------------------------------

export const ExecCommandEnd = Schema.Struct({
  type: Schema.tag("exec_command_end"),
  call_id: Schema.String,
  exit_code: Schema.Int,
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  aggregated_output: Schema.optionalKey(Schema.String),
  duration: Schema.optionalKey(Schema.Struct({ secs: Schema.Number, nanos: Schema.Number })),
  parsed_cmd: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  command: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String)
})
export type ExecCommandEnd = typeof ExecCommandEnd.Type

export const TaskStarted = Schema.Struct({ type: Schema.tag("task_started"), turn_id: Schema.optionalKey(Schema.String) })
export const TaskComplete = Schema.Struct({
  type: Schema.tag("task_complete"),
  turn_id: Schema.optionalKey(Schema.String),
  duration_ms: Schema.optionalKey(Schema.Number)
})
export const TurnAborted = Schema.Struct({
  type: Schema.tag("turn_aborted"),
  turn_id: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  duration_ms: Schema.optionalKey(Schema.Number)
})

const TokenUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.Number),
  cached_input_tokens: Schema.optionalKey(Schema.Number),
  output_tokens: Schema.optionalKey(Schema.Number),
  reasoning_output_tokens: Schema.optionalKey(Schema.Number),
  total_tokens: Schema.optionalKey(Schema.Number)
})
export const TokenCount = Schema.Struct({
  type: Schema.tag("token_count"),
  info: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    last_token_usage: Schema.optionalKey(TokenUsage),
    total_token_usage: Schema.optionalKey(TokenUsage)
  })))
})

export const ParsedRead = Schema.Struct({
  type: Schema.tag("read"),
  path: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const PatchChange = Schema.Struct({
  type: Schema.String,
  unified_diff: Schema.optionalKey(Schema.NullOr(Schema.String)),
  move_path: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const PatchApplyEnd = Schema.Struct({
  type: Schema.tag("patch_apply_end"),
  call_id: Schema.String,
  success: Schema.Boolean,
  changes: Schema.optionalKey(Schema.Record(Schema.String, PatchChange))
})
export type PatchApplyEnd = typeof PatchApplyEnd.Type

export const ThreadNameUpdated = Schema.Struct({
  type: Schema.tag("thread_name_updated"),
  thread_name: Schema.String
})

export const EventMsg = Schema.Union([ExecCommandEnd, PatchApplyEnd, ThreadNameUpdated, TaskStarted, TaskComplete, TurnAborted, TokenCount])
export type EventMsg = typeof EventMsg.Type
export const EVENT_MSG_TYPES: ReadonlySet<string> = new Set([
  "exec_command_end",
  "patch_apply_end",
  "thread_name_updated",
  "task_started",
  "task_complete",
  "turn_aborted",
  "token_count"
])

/** Top-level rollout line types with no canonical meaning of their own. */
export const IGNORED_LINE_TYPES: ReadonlySet<string> = new Set(["event_msg"])

/** JSON-encoded tool output: `{"output": "...", "metadata": {"exit_code": 0}}`. */
export const StructuredOutput = Schema.Struct({
  output: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Struct({ exit_code: Schema.optionalKey(Schema.Int) }))
})

export const ObjectOutput = Schema.Struct({
  content: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})
