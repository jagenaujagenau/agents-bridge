import { Schema } from "effect"
import { ContentBlock } from "./content.ts"
import { CommandId, EventId, SessionId, Timestamp, ToolCallId } from "./ids.ts"
import { Certainty, SourceReference } from "./source.ts"

/**
 * Fields shared by every event. The discriminator is `type` both in memory and
 * on the wire, so there is no `_tag` → `type` transformation to maintain.
 */
export const BaseEventFields = {
  id: EventId,
  sessionId: SessionId,
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  timestamp: Schema.optionalKey(Timestamp),
  durationMs: Schema.optionalKey(Schema.Finite),
  /** Structural parent, e.g. the `tool.started` a `command.started` belongs to. */
  parentEventId: Schema.optionalKey(EventId),
  /** Events this event was derived from. */
  derivedFrom: Schema.optionalKey(Schema.Array(EventId)),
  certainty: Certainty,
  source: SourceReference
}

const event = <const Type extends string, const Fields extends Schema.Struct.Fields>(type: Type, fields: Fields) =>
  Schema.Struct({ type: Schema.tag(type), ...BaseEventFields, ...fields }).pipe(
    Schema.annotate({ identifier: type })
  )

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export const SessionStarted = event("session.started", {})
export type SessionStarted = typeof SessionStarted.Type

/** Only emitted when the source proves the session ended. History normally does not. */
export const SessionCompleted = event("session.completed", {})
export type SessionCompleted = typeof SessionCompleted.Type

export const SessionFailed = event("session.failed", {
  message: Schema.optionalKey(Schema.String)
})
export type SessionFailed = typeof SessionFailed.Type

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/** A prompt written by the session's principal (a human, or the parent agent for subagent sessions). */
export const UserMessage = event("user.message", {
  content: Schema.Array(ContentBlock)
})
export type UserMessage = typeof UserMessage.Type

export const AgentMessage = event("agent.message", {
  content: Schema.Array(ContentBlock)
})
export type AgentMessage = typeof AgentMessage.Type

export const ReasoningRepresentation = Schema.Literals(["summary", "provider_exposed"])
export type ReasoningRepresentation = typeof ReasoningRepresentation.Type

/** Reasoning the provider exposed. Bridge never reconstructs hidden reasoning. */
export const AgentReasoning = event("agent.reasoning", {
  content: Schema.String,
  representation: ReasoningRepresentation
})
export type AgentReasoning = typeof AgentReasoning.Type

export const NoticeKind = Schema.Literals([
  "injected_context",
  "command_output",
  "task_notification",
  "hook",
  "interruption",
  /** The harness or model provider reported an error (API failure, aborted turn). */
  "error",
  "other"
])
export type NoticeKind = typeof NoticeKind.Type

/**
 * Text the harness injected into the conversation (environment context,
 * instruction files, command output, notifications). It travels in the
 * provider's user role but was not written by the principal.
 */
export const HarnessNotice = event("harness.notice", {
  kind: NoticeKind,
  content: Schema.Array(ContentBlock)
})
export type HarnessNotice = typeof HarnessNotice.Type

/** The harness replaced earlier context with a summary. */
export const ContextCompacted = event("context.compacted", {
  summary: Schema.optionalKey(Schema.String)
})
export type ContextCompacted = typeof ContextCompacted.Type

// ---------------------------------------------------------------------------
// Turns and usage
// ---------------------------------------------------------------------------

/** A prompt-to-response cycle, emitted only where the source records turn boundaries. */
export const TurnStarted = event("turn.started", {
  turnId: Schema.String
})
export type TurnStarted = typeof TurnStarted.Type

export const TurnOutcome = Schema.Literals(["completed", "interrupted", "failed", "unknown"])
export type TurnOutcome = typeof TurnOutcome.Type

export const TurnCompleted = event("turn.completed", {
  turnId: Schema.String,
  outcome: TurnOutcome
})
export type TurnCompleted = typeof TurnCompleted.Type

const TokenCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/**
 * Tokens consumed by one model call. A delta, never a running total, so consumers
 * sum events to get session totals. Fields the source does not record are omitted.
 * Total input = inputTokens + cacheReadTokens + cacheWriteTokens.
 */
export const UsageRecorded = event("usage.recorded", {
  model: Schema.optionalKey(Schema.String),
  /** Input tokens not served from a prompt cache. */
  inputTokens: Schema.optionalKey(TokenCount),
  /** Input tokens served from a prompt cache. */
  cacheReadTokens: Schema.optionalKey(TokenCount),
  /** Input tokens written to a prompt cache. */
  cacheWriteTokens: Schema.optionalKey(TokenCount),
  /** All generated tokens, reasoning included. */
  outputTokens: Schema.optionalKey(TokenCount),
  /** The reasoning share of `outputTokens`. */
  reasoningTokens: Schema.optionalKey(TokenCount)
})
export type UsageRecorded = typeof UsageRecorded.Type

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed"]),
  priority: Schema.optionalKey(Schema.Literals(["high", "medium", "low"]))
}).pipe(Schema.annotate({ identifier: "PlanEntry" }))
export type PlanEntry = typeof PlanEntry.Type

/** The agent's current plan, replacing any earlier one (ACP `plan` semantics). */
export const PlanUpdated = event("plan.updated", {
  entries: Schema.Array(PlanEntry)
})
export type PlanUpdated = typeof PlanUpdated.Type

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** ACP-aligned tool classification, so generic tool views never need native tool names. */
export const ToolKind = Schema.Literals([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other"
])
export type ToolKind = typeof ToolKind.Type

export const ToolStarted = event("tool.started", {
  toolCallId: ToolCallId,
  name: Schema.String,
  kind: ToolKind,
  input: Schema.optionalKey(Schema.Json)
})
export type ToolStarted = typeof ToolStarted.Type

/** Incremental metadata: omitted fields remain unchanged; input: null explicitly clears input. */
export const ToolUpdated = event("tool.updated", {
  toolCallId: ToolCallId,
  name: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(ToolKind),
  input: Schema.optionalKey(Schema.Json)
})
export type ToolUpdated = typeof ToolUpdated.Type

export const ToolCompleted = event("tool.completed", {
  toolCallId: ToolCallId,
  output: Schema.optionalKey(Schema.Json)
})
export type ToolCompleted = typeof ToolCompleted.Type

export const ToolFailed = event("tool.failed", {
  toolCallId: ToolCallId,
  message: Schema.String
})
export type ToolFailed = typeof ToolFailed.Type

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const CommandStarted = event("command.started", {
  commandId: CommandId,
  command: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  shell: Schema.optionalKey(Schema.String)
})
export type CommandStarted = typeof CommandStarted.Type

export const CommandOutcome = Schema.Literals(["succeeded", "failed", "interrupted", "unknown"])
export type CommandOutcome = typeof CommandOutcome.Type

export const CommandCompleted = event("command.completed", {
  commandId: CommandId,
  /** Always present, so consumers never have to interpret exit codes. */
  outcome: CommandOutcome,
  /** Absent when the source does not record it. Never defaulted to 0. */
  exitCode: Schema.optionalKey(Schema.Int),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String)
})
export type CommandCompleted = typeof CommandCompleted.Type

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Paths are preserved exactly as the source observed them. */
export const FileRead = event("file.read", {
  path: Schema.String
})
export type FileRead = typeof FileRead.Type

export const FileCreated = event("file.created", {
  path: Schema.String,
  diff: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String)
})
export type FileCreated = typeof FileCreated.Type

export const FileChanged = event("file.changed", {
  path: Schema.String,
  previousPath: Schema.optionalKey(Schema.String),
  previousHash: Schema.optionalKey(Schema.String),
  currentHash: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String)
})
export type FileChanged = typeof FileChanged.Type

export const FileDeleted = event("file.deleted", {
  path: Schema.String
})
export type FileDeleted = typeof FileDeleted.Type

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * A git commit the session made, derived by an enricher from a `git commit` command.
 * Always `inferred`; `derivedFrom` names the command events.
 */
export const GitCommit = event("git.commit", {
  commit: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String)
})
export type GitCommit = typeof GitCommit.Type

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Provider extension events: `custom.<namespace>.<event>`. Consumers may ignore them. */
export const CustomEvent = Schema.Struct({
  type: Schema.TemplateLiteral(["custom.", Schema.String]),
  ...BaseEventFields,
  payload: Schema.Json
}).pipe(Schema.annotate({ identifier: "custom" }))
export type CustomEvent = typeof CustomEvent.Type

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export const SessionEvent = Schema.Union([
  SessionStarted,
  SessionCompleted,
  SessionFailed,
  UserMessage,
  AgentMessage,
  AgentReasoning,
  HarnessNotice,
  ContextCompacted,
  TurnStarted,
  TurnCompleted,
  UsageRecorded,
  PlanUpdated,
  ToolStarted,
  ToolUpdated,
  ToolCompleted,
  ToolFailed,
  CommandStarted,
  CommandCompleted,
  FileRead,
  FileCreated,
  FileChanged,
  FileDeleted,
  GitCommit,
  CustomEvent
]).pipe(Schema.annotate({ identifier: "SessionEvent", title: "Bridge SessionEvent" }))
export type SessionEvent = typeof SessionEvent.Type
export type EncodedSessionEvent = typeof SessionEvent.Encoded

export type CanonicalEventType = Exclude<SessionEvent["type"], CustomEvent["type"]>
export type EventOfType<T extends SessionEvent["type"]> = Extract<SessionEvent, { readonly type: T }>

export const canonicalEventTypes: ReadonlyArray<CanonicalEventType> = [
  "session.started",
  "session.completed",
  "session.failed",
  "user.message",
  "agent.message",
  "agent.reasoning",
  "harness.notice",
  "context.compacted",
  "turn.started",
  "turn.completed",
  "usage.recorded",
  "plan.updated",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "tool.failed",
  "command.started",
  "command.completed",
  "file.read",
  "file.created",
  "file.changed",
  "file.deleted",
  "git.commit"
]

export const isEventType = <T extends SessionEvent["type"]>(type: T) =>
(event: SessionEvent): event is EventOfType<T> => event.type === type

/** Distributive omit, so event-shaped object literals keep their discriminated union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event before the adapter assigns identity and ordering. */
export type EventDraft = DistributiveOmit<SessionEvent, "id" | "sessionId" | "sequence">
