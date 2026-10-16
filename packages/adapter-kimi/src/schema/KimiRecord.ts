import { Option, Schema } from "effect"

/**
 * Provider schemas for Kimi Code (`@moonshot-ai/kimi-code` 2.x) agent wires:
 * `${KIMI_CODE_HOME:-~/.kimi-code}/sessions/<wd_slug_hash>/<session_id>/agents/<agentId>/wire.jsonl`.
 *
 * The wire is an event-sourced journal (protocol 1.0–1.5): every line is a durable
 * agent event serialized as `{ type, ...payload, time }` with `time` in epoch ms.
 * Assistant output is not stored as messages but as loop events
 * (`context.append_loop_event` → `step.begin` / `content.part` / `tool.call` /
 * `tool.result` / `step.end`). Deliberately lenient: unknown keys are ignored and
 * payloads Bridge only reads a few fields of stay `Unknown`.
 */

const Time = Schema.Union([Schema.Number, Schema.String])

// ---------------------------------------------------------------------------
// Top-level records
// ---------------------------------------------------------------------------

/** First line of every wire. */
export const MetadataRecord = Schema.Struct({
  type: Schema.tag("metadata"),
  protocol_version: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Schema.Number)
})
export type MetadataRecord = typeof MetadataRecord.Type

/** `config.update` and `profile.bind`: the agent's model alias and environment. */
export const ConfigRecord = Schema.Struct({
  type: Schema.Literals(["config.update", "profile.bind"]),
  modelAlias: Schema.optionalKey(Schema.String),
  profileName: Schema.optionalKey(Schema.String),
  environmentDisclosure: Schema.optionalKey(Schema.Unknown),
  time: Schema.optionalKey(Time)
})
export type ConfigRecord = typeof ConfigRecord.Type

/** A turn begins. `turnId` is absent in imported (kimi-cli) wires, where turns are counted. */
export const TurnPromptRecord = Schema.Struct({
  type: Schema.tag("turn.prompt"),
  turnId: Schema.optionalKey(Schema.Number),
  promptId: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.Unknown),
  time: Schema.optionalKey(Time)
})
export type TurnPromptRecord = typeof TurnPromptRecord.Type

export const TurnEndedRecord = Schema.Struct({
  type: Schema.tag("turn.ended"),
  turnId: Schema.Number,
  /** `completed`, `cancelled`, `failed` or `blocked`. */
  reason: Schema.String,
  error: Schema.optionalKey(Schema.Unknown),
  durationMs: Schema.optionalKey(Schema.Number),
  time: Schema.optionalKey(Time)
})
export type TurnEndedRecord = typeof TurnEndedRecord.Type

export const ContextMessage = Schema.Struct({
  /** `user`, `assistant`, `tool` or `system`. */
  role: Schema.String,
  content: Schema.optionalKey(Schema.Unknown),
  /** Assistant messages of imported wires only; live wires record calls as loop events. */
  toolCalls: Schema.optionalKey(Schema.Unknown),
  /** Who put the message there (`user`, `injection`, `system_trigger`, `task`, …). */
  origin: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  isError: Schema.optionalKey(Schema.Boolean)
})
export type ContextMessage = typeof ContextMessage.Type

export const AppendMessageRecord = Schema.Struct({
  type: Schema.tag("context.append_message"),
  message: ContextMessage,
  time: Schema.optionalKey(Time)
})
export type AppendMessageRecord = typeof AppendMessageRecord.Type

/** A loop event; the inner `event` is decoded separately so new event types surface as warnings. */
export const LoopEventRecord = Schema.Struct({
  type: Schema.tag("context.append_loop_event"),
  event: Schema.Unknown,
  time: Schema.optionalKey(Time)
})
export type LoopEventRecord = typeof LoopEventRecord.Type

export const ApplyCompactionRecord = Schema.Struct({
  type: Schema.tag("context.apply_compaction"),
  /** A string, or (older engines) a context message. */
  summary: Schema.optionalKey(Schema.Unknown),
  contextSummary: Schema.optionalKey(Schema.String),
  time: Schema.optionalKey(Time)
})
export type ApplyCompactionRecord = typeof ApplyCompactionRecord.Type

/** One per completed LLM request, written by the requester. */
export const UsageRecord = Schema.Struct({
  type: Schema.tag("usage.record"),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(Schema.Unknown),
  /** `turn` (agent loop) or `session` (compaction, titles, …). */
  usageScope: Schema.optionalKey(Schema.String),
  time: Schema.optionalKey(Time)
})
export type UsageRecord = typeof UsageRecord.Type

/** Written to the caller's wire when the Agent tool spawns (or resumes) a subagent. */
export const SubagentSpawnedRecord = Schema.Struct({
  type: Schema.tag("subagent.spawned"),
  subagentId: Schema.String,
  subagentName: Schema.optionalKey(Schema.String),
  parentToolCallId: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  runInBackground: Schema.optionalKey(Schema.Boolean),
  time: Schema.optionalKey(Time)
})
export type SubagentSpawnedRecord = typeof SubagentSpawnedRecord.Type

/** A detached (background) task ended. Foreground Bash commands never produce one. */
export const TaskTerminatedRecord = Schema.Struct({
  type: Schema.tag("task.terminated"),
  info: Schema.Unknown,
  outputTail: Schema.optionalKey(Schema.String),
  time: Schema.optionalKey(Time)
})
export type TaskTerminatedRecord = typeof TaskTerminatedRecord.Type

export const KimiRecord = Schema.Union([
  MetadataRecord,
  ConfigRecord,
  TurnPromptRecord,
  TurnEndedRecord,
  AppendMessageRecord,
  LoopEventRecord,
  ApplyCompactionRecord,
  UsageRecord,
  SubagentSpawnedRecord,
  TaskTerminatedRecord
])
export type KimiRecord = typeof KimiRecord.Type

export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "metadata",
  "config.update",
  "profile.bind",
  "turn.prompt",
  "turn.ended",
  "context.append_message",
  "context.append_loop_event",
  "context.apply_compaction",
  "usage.record",
  "subagent.spawned",
  "task.terminated"
])

/**
 * Durable record types with no canonical meaning (engine state, approvals, goals, tool
 * registry snapshots, file-history checkpoints, …), plus the observable ones Kimi's own
 * wire readers list. `turn.steer` repeats a `context.append_message`; `subagent.*` outcomes
 * repeat the Agent tool result; `tools.update_store` repeats the TodoList call.
 */
export const METADATA_TYPES: ReadonlySet<string> = new Set([
  "forked",
  "turn.steer",
  "turn.cancel",
  "turn.step.interrupted",
  "turn.step.retrying",
  "prompt.accepted",
  "prompt.aborted",
  "prompt.completed",
  "prompt.steered",
  "interaction.request",
  "interaction.resolved",
  "task.started",
  "task.waitDelivered",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "subagent.cancelled",
  "subagent.suspended",
  "cron.add",
  "cron.cursor",
  "cron.delete",
  "plan.revision",
  "plan_mode.enter",
  "plan_mode.exit",
  "plan_mode.cancel",
  "plugin.session_start",
  "runtime.set_binding",
  "staleGuard.recorded",
  "staleGuard.cleared",
  "interruptionReminder.recorded",
  "permission.record_approval_result",
  "permission.set_mode",
  "full_compaction.begin",
  "full_compaction.cancel",
  "full_compaction.complete",
  "micro_compaction.apply",
  "context.clear",
  "context.undo",
  "context.update_token_count",
  "tools.register_user_tool",
  "tools.unregister_user_tool",
  "tools.set_active_tools",
  "tools.reset_active_tools",
  "tools.update_store",
  "llm.tools_snapshot",
  "llm.request",
  "mcp.tools_discovered",
  "file_history.checkpoint",
  "file_history.tracked",
  "token_counting.measured",
  "token_counting.truncated",
  "token_counting.rebased",
  "token_counting.turn_recorded",
  "goal.create",
  "goal.update",
  "goal.clear",
  "swarm_mode.enter",
  "swarm_mode.exit",
  "tower_mode.enter",
  "tower_mode.exit"
])

// ---------------------------------------------------------------------------
// Loop events (inside `context.append_loop_event`)
// ---------------------------------------------------------------------------

export const StepBeginEvent = Schema.Struct({
  type: Schema.tag("step.begin"),
  uuid: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
  step: Schema.optionalKey(Schema.Number)
})

export const StepEndEvent = Schema.Struct({
  type: Schema.tag("step.end"),
  uuid: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
  /** `completed`, `tool_calls`, `truncated`, `filtered`, `paused`, `other`, `interrupted`, `error`. */
  finishReason: Schema.optionalKey(Schema.String)
})

export const ContentPartEvent = Schema.Struct({
  type: Schema.tag("content.part"),
  uuid: Schema.optionalKey(Schema.String),
  stepUuid: Schema.optionalKey(Schema.String),
  part: Schema.Unknown
})

export const ToolCallEvent = Schema.Struct({
  type: Schema.tag("tool.call"),
  uuid: Schema.optionalKey(Schema.String),
  stepUuid: Schema.optionalKey(Schema.String),
  toolCallId: Schema.String,
  name: Schema.String,
  args: Schema.optionalKey(Schema.Unknown),
  /** The tool's UI display (`file_io` with the resolved absolute path, `command`, `agent_call`, …). */
  display: Schema.optionalKey(Schema.Unknown)
})

export const ToolResultEvent = Schema.Struct({
  type: Schema.tag("tool.result"),
  parentUuid: Schema.optionalKey(Schema.String),
  toolCallId: Schema.String,
  result: Schema.Struct({
    /** A string, or content parts. */
    output: Schema.optionalKey(Schema.Unknown),
    isError: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    note: Schema.optionalKey(Schema.Unknown)
  })
})

export const LoopEvent = Schema.Union([StepBeginEvent, StepEndEvent, ContentPartEvent, ToolCallEvent, ToolResultEvent])
export type LoopEvent = typeof LoopEvent.Type

export const KNOWN_LOOP_EVENTS: ReadonlySet<string> = new Set(["step.begin", "step.end", "content.part", "tool.call", "tool.result"])

// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

export const TextPart = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  /** `{ source: "skill activation" | "user prompt submit hook" }` on injected parts. */
  meta: Schema.optionalKey(Schema.Unknown)
})
export const ThinkPart = Schema.Struct({
  type: Schema.tag("think"),
  think: Schema.String,
  encrypted: Schema.optionalKey(Schema.Unknown),
  hidden: Schema.optionalKey(Schema.Boolean)
})
export const ImagePart = Schema.Struct({
  type: Schema.tag("image_url"),
  imageUrl: Schema.Struct({ url: Schema.String })
})

export const KnownPart = Schema.Union([TextPart, ThinkPart, ImagePart])
export type KnownPart = typeof KnownPart.Type
/** Audio, video and future parts carry nothing Bridge renders. */
export type KimiPart = KnownPart | { readonly type: "unknown"; readonly nativeType: string }

const decodeKnownPart = Schema.decodeUnknownOption(KnownPart)

export const decodePart = (raw: unknown): KimiPart =>
  Option.getOrElse(decodeKnownPart(raw), (): KimiPart => ({
    type: "unknown",
    nativeType: typeof raw === "object" && raw !== null && "type" in raw ? String(raw.type) : "?"
  }))

/** Message content: a string or an array of parts. */
export const decodeParts = (content: unknown): ReadonlyArray<KimiPart> =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
    ? content.map(decodePart)
    : []

// ---------------------------------------------------------------------------
// Sidecars
// ---------------------------------------------------------------------------

/** `<session dir>/state.json`. Only the fields Bridge uses; the rest is ignored. */
export const SessionState = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  /** Legacy spelling of `cwd`. */
  workDir: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  /** `custom` (user-set), `generated` (model-written) or `replaceable` (from the prompt). */
  titleKind: Schema.optionalKey(Schema.String),
  isCustomTitle: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.optionalKey(Time),
  forkedFrom: Schema.optionalKey(Schema.String),
  agents: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})
export type SessionState = typeof SessionState.Type
