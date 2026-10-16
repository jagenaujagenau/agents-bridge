import { Option, Schema } from "effect"

/**
 * Provider schemas for Factory Droid `~/.factory/sessions/<project>/<id>.jsonl` records
 * (CLI 0.242, session format `version: 2`). Deliberately lenient: unknown keys are
 * ignored and unknown content blocks decode to a fallback, so new provider fields
 * never break a session.
 */

// ---------------------------------------------------------------------------
// Content blocks (Anthropic snake_case, as Droid persists them)
// ---------------------------------------------------------------------------

export const TextBlock = Schema.Struct({ type: Schema.tag("text"), text: Schema.String })
export const ThinkingBlock = Schema.Struct({ type: Schema.tag("thinking"), thinking: Schema.String })
export const ToolUseBlock = Schema.Struct({
  type: Schema.tag("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.optionalKey(Schema.Unknown)
})
/** Persisted as `tool_use_id` / `is_error`; the in-memory camelCase spelling is accepted too. */
export const ToolResultBlock = Schema.Struct({
  type: Schema.tag("tool_result"),
  tool_use_id: Schema.optionalKey(Schema.String),
  toolUseId: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Unknown),
  is_error: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  isError: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})

export const KnownBlock = Schema.Union([TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock])
export type KnownBlock = typeof KnownBlock.Type
/** `redacted_thinking`, `image`, `document` and future blocks carry nothing Bridge renders. */
export type DroidBlock = KnownBlock | { readonly type: "unknown"; readonly nativeType: string }

const decodeKnownBlock = Schema.decodeUnknownOption(KnownBlock)

export const decodeBlocks = (content: string | ReadonlyArray<unknown>): ReadonlyArray<DroidBlock> =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map((raw) =>
      Option.getOrElse(decodeKnownBlock(raw), (): DroidBlock => ({
        type: "unknown",
        nativeType: typeof raw === "object" && raw !== null && "type" in raw ? String(raw.type) : "?"
      }))
    )

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Line 1 of every session file; rewritten in place when the title changes. */
export const SessionStartRecord = Schema.Struct({
  type: Schema.tag("session_start"),
  id: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  isSessionTitleManuallySet: Schema.optionalKey(Schema.Boolean),
  /** The session this one was forked from. */
  parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Set on subagent (Task) sessions and `/btw` side questions: the session that started this one. */
  callingSessionId: Schema.optionalKey(Schema.String),
  callingToolUseId: Schema.optionalKey(Schema.String),
  forkedAtMessageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  version: Schema.optionalKey(Schema.Number),
  cwd: Schema.optionalKey(Schema.String),
  lastCwd: Schema.optionalKey(Schema.String)
})
export type SessionStartRecord = typeof SessionStartRecord.Type

export const MessageRecord = Schema.Struct({
  type: Schema.tag("message"),
  id: Schema.String,
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  timestamp: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.Struct({
    /** `user`, `assistant`, `tool` or `system`. */
    role: Schema.String,
    content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
    /** `both` (default), `llm_only` (hidden from the user) or `user_only` (never sent to the model). */
    visibility: Schema.optionalKey(Schema.String),
    /** Present on messages a hook injected. */
    hookEventName: Schema.optionalKey(Schema.String)
  }),
  /** A single context-size number, not split into input and output; not usage per call. */
  tokens: Schema.optionalKey(Schema.Number)
})
export type MessageRecord = typeof MessageRecord.Type

/** The plan after a successful TodoWrite. `todos` is the tool's parsed input. */
export const TodoStateRecord = Schema.Struct({
  type: Schema.tag("todo_state"),
  id: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  todos: Schema.Unknown
})
export type TodoStateRecord = typeof TodoStateRecord.Type

export const CompactionStateRecord = Schema.Struct({
  type: Schema.tag("compaction_state"),
  id: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  summaryText: Schema.optionalKey(Schema.String),
  removedCount: Schema.optionalKey(Schema.Number)
})
export type CompactionStateRecord = typeof CompactionStateRecord.Type

/** The end of a turn; `turnId` is the ID of the user message that started it. */
export const AgentTurnOutcomeRecord = Schema.Struct({
  type: Schema.tag("agent_turn_outcome"),
  turnId: Schema.String,
  reason: Schema.String
})
export type AgentTurnOutcomeRecord = typeof AgentTurnOutcomeRecord.Type

export const DroidRecord = Schema.Union([
  SessionStartRecord,
  MessageRecord,
  TodoStateRecord,
  CompactionStateRecord,
  AgentTurnOutcomeRecord
])
export type DroidRecord = typeof DroidRecord.Type

export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "session_start",
  "message",
  "todo_state",
  "compaction_state",
  "agent_turn_outcome"
])

/** Record types with no canonical meaning. None are confirmed yet; new types surface as warnings. */
export const METADATA_TYPES: ReadonlySet<string> = new Set([])

/** The sibling `<id>.settings.json`. Only the model is read; token totals are session sums, not per call. */
export const SessionSettings = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  reasoningEffort: Schema.optionalKey(Schema.String)
})
