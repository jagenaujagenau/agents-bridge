import { Schema } from "effect"

/**
 * Provider schemas for GitHub Copilot CLI session logs
 * (`${COPILOT_HOME:-~/.copilot}/session-state/<sessionId>/events.jsonl`).
 *
 * Every line is one session event `{type, data, id, timestamp, parentId, agentId?}`
 * (the shape `@github/copilot-sdk` generates as `SessionEvent`). Events the runtime
 * marks `ephemeral` are never written to disk, which is why per-call usage
 * (`assistant.usage`), turn markers of subagents and streaming deltas are absent.
 *
 * Subagent work is written inline into the parent's log: those events carry
 * `agentId` (older releases: `data.parentToolCallId`).
 *
 * Unknown keys are ignored so newer CLI versions keep decoding.
 */

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

/** Working directory and git context (`session.start`, `session.resume`, `session.context_changed`). */
export const WorkingDirectoryContext = Schema.Struct({
  cwd: optional(Schema.String),
  gitRoot: optional(Schema.String),
  branch: optional(Schema.String),
  headCommit: optional(Schema.String),
  repository: optional(Schema.String),
  pendingGitContext: optional(Schema.Boolean)
})
export type WorkingDirectoryContext = typeof WorkingDirectoryContext.Type

export const StartData = Schema.Struct({
  sessionId: Schema.String,
  copilotVersion: optional(Schema.String),
  startTime: optional(Schema.String),
  selectedModel: optional(Schema.String),
  context: optional(WorkingDirectoryContext)
})

export const ResumeData = Schema.Struct({
  selectedModel: optional(Schema.String),
  context: optional(WorkingDirectoryContext)
})

export const ModelChangeData = Schema.Struct({ newModel: Schema.String })

export const MessageData = Schema.Struct({
  message: Schema.String,
  errorType: optional(Schema.String),
  warningType: optional(Schema.String),
  infoType: optional(Schema.String)
})

export const ShutdownData = Schema.Struct({
  shutdownType: optional(Schema.String),
  errorReason: optional(Schema.String),
  currentModel: optional(Schema.String),
  modelMetrics: optional(Schema.Unknown)
})

export const CompactionCompleteData = Schema.Struct({
  success: Schema.Boolean,
  summaryContent: optional(Schema.String),
  error: optional(Schema.String)
})

export const UserMessageData = Schema.Struct({
  content: Schema.String,
  source: optional(Schema.String),
  isAutopilotContinuation: optional(Schema.Boolean),
  delivery: optional(Schema.String),
  interactionId: optional(Schema.String)
})

export const TurnData = Schema.Struct({
  turnId: Schema.String,
  interactionId: optional(Schema.String),
  parentToolCallId: optional(Schema.String)
})

export const ToolRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.String,
  arguments: optional(Schema.Unknown)
})
export type ToolRequest = typeof ToolRequest.Type

export const AssistantMessageData = Schema.Struct({
  messageId: optional(Schema.String),
  content: optional(Schema.String),
  model: optional(Schema.String),
  toolRequests: optional(Schema.Array(ToolRequest)),
  outputTokens: optional(Schema.Number),
  reasoningText: optional(Schema.String),
  apiCallId: optional(Schema.String),
  chunkIndex: optional(Schema.Number),
  chunkCount: optional(Schema.Number),
  parentToolCallId: optional(Schema.String)
})
export type AssistantMessageData = typeof AssistantMessageData.Type

export const ReasoningData = Schema.Struct({
  reasoningId: optional(Schema.String),
  content: Schema.String
})

export const AbortData = Schema.Struct({ reason: optional(Schema.String) })

export const ToolStartData = Schema.Struct({
  toolCallId: Schema.String,
  toolName: Schema.String,
  arguments: optional(Schema.Unknown),
  mcpServerName: optional(Schema.String),
  parentToolCallId: optional(Schema.String)
})
export type ToolStartData = typeof ToolStartData.Type

export const FileEdit = Schema.Struct({ kind: Schema.String, path: Schema.String })

export const ToolCompleteData = Schema.Struct({
  toolCallId: Schema.String,
  success: Schema.Boolean,
  result: optional(Schema.Struct({
    content: optional(Schema.String),
    detailedContent: optional(Schema.String),
    contents: optional(Schema.Array(Schema.Unknown))
  })),
  error: optional(Schema.Union([Schema.String, Schema.Struct({ message: optional(Schema.String), code: optional(Schema.String) })])),
  /** Experimental (1.0.9x): mutations a built-in edit tool committed. Absolute paths. */
  fileEdits: optional(Schema.Array(FileEdit)),
  /** Experimental (1.0.9x): shell facts captured before the persisted result contents are stripped. */
  shellExecution: optional(Schema.Struct({ exitCode: Schema.Number })),
  parentToolCallId: optional(Schema.String)
})
export type ToolCompleteData = typeof ToolCompleteData.Type

export const SkillInvokedData = Schema.Struct({
  name: Schema.String,
  content: optional(Schema.String)
})

export const SubagentData = Schema.Struct({
  /** The `task` tool call that spawned the subagent. */
  toolCallId: Schema.String,
  agentName: optional(Schema.String),
  agentDisplayName: optional(Schema.String),
  model: optional(Schema.String),
  cancelled: optional(Schema.Boolean),
  error: optional(Schema.String)
})
export type SubagentData = typeof SubagentData.Type

export const SystemNotificationData = Schema.Struct({ content: Schema.String })

export const HookEndData = Schema.Struct({
  hookType: optional(Schema.String),
  success: Schema.Boolean,
  error: optional(Schema.Unknown)
})

const envelope = {
  id: optional(Schema.String),
  parentId: optional(Schema.String),
  timestamp: optional(Schema.String),
  agentId: optional(Schema.String)
}

const record = <const T extends string, D extends Schema.Top>(type: T, data: D) =>
  Schema.Struct({ type: Schema.tag(type), data, ...envelope })

export const CopilotRecord = Schema.Union([
  record("session.start", StartData),
  record("session.resume", ResumeData),
  record("session.model_change", ModelChangeData),
  record("session.context_changed", WorkingDirectoryContext),
  record("session.error", MessageData),
  record("session.warning", MessageData),
  record("session.info", MessageData),
  record("session.shutdown", ShutdownData),
  record("session.compaction_complete", CompactionCompleteData),
  record("user.message", UserMessageData),
  record("assistant.turn_start", TurnData),
  record("assistant.turn_end", TurnData),
  record("assistant.message", AssistantMessageData),
  record("assistant.reasoning", ReasoningData),
  record("abort", AbortData),
  record("tool.execution_start", ToolStartData),
  record("tool.execution_complete", ToolCompleteData),
  record("skill.invoked", SkillInvokedData),
  record("subagent.started", SubagentData),
  record("subagent.completed", SubagentData),
  record("subagent.failed", SubagentData),
  record("system.notification", SystemNotificationData),
  record("hook.end", HookEndData)
])
export type CopilotRecord = typeof CopilotRecord.Type

export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "session.start",
  "session.resume",
  "session.model_change",
  "session.context_changed",
  "session.error",
  "session.warning",
  "session.info",
  "session.shutdown",
  "session.compaction_complete",
  "user.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message",
  "assistant.reasoning",
  "abort",
  "tool.execution_start",
  "tool.execution_complete",
  "skill.invoked",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "system.notification",
  "hook.end"
])

/**
 * Event types in the 1.0.9x schema that carry no canonical fact. Most are `ephemeral` and
 * never reach disk; the rest are configuration, UI state, permissions and telemetry.
 * Listed explicitly so a new type surfaces as `unknown_record_type`.
 */
export const IGNORED_TYPES: ReadonlySet<string> = new Set([
  // session configuration and UI state
  "session.remote_steerable_changed",
  "session.idle",
  "session.title_changed",
  "session.schedule_created",
  "session.schedule_cancelled",
  "session.schedule_rearmed",
  "session.autopilot_objective_changed",
  "session.indexed_search",
  "session.model_deselected",
  "session.auto_tier_recommendation",
  "session.auto_tier_switch_failed",
  "session.mode_changed",
  "session.mode_notice_delivered",
  "session.session_limits_changed",
  "session.permissions_changed",
  "session.plan_changed",
  "session.todos_changed",
  "session.workspace_file_changed",
  "session.handoff",
  "session.truncation",
  "session.snapshot_rewind",
  "session.usage_checkpoint",
  "session.quota_observation",
  "session.usage_info",
  "session.context_cleared",
  "session.compaction_start",
  "session.task_complete",
  "session.completion_receipt",
  "session.fusion_route_started",
  "session.fusion_route_failed",
  "session.fusion_resolved",
  "session.fusion_completed",
  "session.permission_recovery",
  "session.binary_asset",
  "session.custom_notification",
  "session.auto_mode_resolved",
  "session.managed_plugin_progress",
  "session.managed_settings_resolved",
  "session.managed_settings_enforced",
  "session.tools_updated",
  "session.background_tasks_changed",
  "session.skills_loaded",
  "session.custom_agents_updated",
  "session.mcp_servers_loaded",
  "session.mcp_server_status_changed",
  "session.mcp_server_removed",
  "session.mcp_server_needs_reconnect",
  "session.extensions_loaded",
  "session.canvas.opened",
  "session.canvas.registry_changed",
  "session.canvas.closed",
  "session.canvas.unavailable",
  "session.canvas.recorded",
  "session.canvas.removed",
  "session.extensions.attachments_pushed",
  "pending_messages.modified",
  // assistant streaming and telemetry
  "assistant.intent",
  "assistant.fusion_phase_started",
  "assistant.fusion_phase_activity",
  "assistant.fusion_phase_completed",
  "assistant.fusion_phase_failed",
  "assistant.server_tool_progress",
  "assistant.reasoning_delta",
  "assistant.tool_call_delta",
  "assistant.streaming_delta",
  "assistant.message_start",
  "assistant.message_delta",
  "assistant.idle",
  "assistant.usage",
  "model.call_failure",
  "model.call_finished",
  // tools: progress, user-requested shell echoes, deltas
  "tool.user_requested",
  "tool.execution_partial_result",
  "tool.shell_output",
  "tool.execution_progress",
  "tool_search.activated",
  "external_tool.requested",
  "external_tool.completed",
  "mcp_app.tool_call_complete",
  // subagent selection, hooks, prompts
  "subagent.configured",
  "subagent.selected",
  "subagent.deselected",
  "hook.start",
  "hook.progress",
  "system.message",
  // permissions and interactive requests
  "permission.requested",
  "permission.completed",
  "permission.carriedForward",
  "permission.messageAuthorization",
  "permission.messageAuthorizationRead",
  "permission.messageAuthorizationDegraded",
  "permission.assentDetected",
  "permission.contextualAuthorization",
  "user_input.requested",
  "user_input.completed",
  "elicitation.requested",
  "elicitation.completed",
  "sampling.requested",
  "sampling.completed",
  "mcp.oauth_required",
  "mcp.oauth_completed",
  "mcp.headers_refresh_required",
  "mcp.headers_refresh_completed",
  "mcp.tools.list_changed",
  "mcp.resources.list_changed",
  "mcp.prompts.list_changed",
  "ui.ephemeral_query",
  "command.queued",
  "command.execute",
  "command.completed",
  "commands.changed",
  "capabilities.changed",
  "auto_mode_switch.requested",
  "auto_mode_switch.completed",
  "session_limits_exhausted.requested",
  "session_limits_exhausted.completed",
  "exit_plan_mode.requested",
  "exit_plan_mode.completed",
  "human_response.recorded",
  "workflow.run_updated",
  "workflow.run_started",
  "workflow.run_settled"
])
