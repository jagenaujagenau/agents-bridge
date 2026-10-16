import { Schema } from "effect"

/**
 * Provider schemas for Qwen Code chat recordings
 * (`${QWEN_RUNTIME_DIR | QWEN_HOME | ~/.qwen}/projects/<sanitized cwd>/chats/<sessionId>.jsonl`,
 * written by `ChatRecordingService` in `@qwen-code/qwen-code-core`).
 *
 * Append-only JSONL. Records form a tree through `uuid` / `parentUuid`; rewinds
 * leave abandoned branches in the file. `message` is a Gemini API `Content`
 * (`{ role, parts }`) with `text`, `thought`, `functionCall` and
 * `functionResponse` parts.
 */

/** Gemini `usageMetadata`, as Qwen Code converts it from every provider. */
export const QwenUsage = Schema.Struct({
  promptTokenCount: Schema.optionalKey(Schema.Unknown),
  candidatesTokenCount: Schema.optionalKey(Schema.Unknown),
  cachedContentTokenCount: Schema.optionalKey(Schema.Unknown),
  thoughtsTokenCount: Schema.optionalKey(Schema.Unknown),
  totalTokenCount: Schema.optionalKey(Schema.Unknown)
})
export type QwenUsage = typeof QwenUsage.Type

export const QwenContent = Schema.Struct({
  role: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(Schema.Unknown))
})

/** One `Part` of a `Content`. Unknown part kinds decode with every field absent. */
export const QwenPart = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thought: Schema.optionalKey(Schema.Boolean),
  functionCall: Schema.optionalKey(Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    name: Schema.String,
    args: Schema.optionalKey(Schema.Unknown)
  })),
  functionResponse: Schema.optionalKey(Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    response: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
  }))
})
export type QwenPart = typeof QwenPart.Type

/** `toolCallResult` on `tool_result` records: UI metadata beside the API-format `message`. */
export const QwenToolCallResult = Schema.Struct({
  callId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  resultDisplay: Schema.optionalKey(Schema.Unknown)
})
export type QwenToolCallResult = typeof QwenToolCallResult.Type

const RecordFields = {
  uuid: Schema.String,
  parentUuid: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sessionId: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  gitBranch: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.NullOr(QwenContent)),
  systemPayload: Schema.optionalKey(Schema.Unknown),
  /** Subagent transcripts: the agent's display name (e.g. "explore"). */
  agentName: Schema.optionalKey(Schema.String),
  isSidechain: Schema.optionalKey(Schema.Boolean),
  /** Every record of a `/branch` fork names the session it was copied from. */
  forkedFrom: Schema.optionalKey(Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) }))
}

export const QwenUserRecord = Schema.Struct({ type: Schema.tag("user"), ...RecordFields })

export const QwenAssistantRecord = Schema.Struct({
  type: Schema.tag("assistant"),
  ...RecordFields,
  model: Schema.optionalKey(Schema.String),
  usageMetadata: Schema.optionalKey(Schema.NullOr(QwenUsage))
})

export const QwenToolResultRecord = Schema.Struct({
  type: Schema.tag("tool_result"),
  ...RecordFields,
  toolCallResult: Schema.optionalKey(Schema.NullOr(QwenToolCallResult))
})

export const QwenSystemRecord = Schema.Struct({ type: Schema.tag("system"), ...RecordFields })

export const QwenRecord = Schema.Union([QwenUserRecord, QwenAssistantRecord, QwenToolResultRecord, QwenSystemRecord])
export type QwenRecord = typeof QwenRecord.Type

export const KNOWN_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "tool_result", "system"])

/** `system` subtypes that carry UI, resume or bookkeeping state only. */
export const IGNORED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "ui_telemetry",
  "attribution_snapshot",
  "file_history_snapshot",
  "session_source",
  "session_execution_engine",
  "session_approval_mode",
  "session_sources_snapshot",
  "session_artifact_event",
  "session_artifact_snapshot",
  "omni_recall",
  "rewind",
  "branch_checkpoint",
  "goal_state",
  "goal_turn_end",
  "turn_attempt",
  "user_text_elements",
  "agent_bootstrap",
  "agent_launch_prompt",
  "agent_retry",
  "agent_session_ready",
  "managed_session_header_v1",
  "managed_session_event_v1",
  "managed_session_commit_v1"
])

/**
 * Records written beside the conversation without moving its tail
 * (`appendRecord(..., { updateActiveTail: false })`): metadata re-anchors and
 * artifact side records. They never decide which branch is active.
 */
export const SIDE_SUBTYPES: ReadonlySet<string> = new Set([
  "custom_title",
  "session_source",
  "session_sources_snapshot",
  "session_artifact_event",
  "session_artifact_snapshot",
  "managed_session_header_v1",
  "managed_session_event_v1",
  "managed_session_commit_v1"
])

/** Payload decoders for the `system` subtypes the normalizer reads. */
export const CustomTitlePayload = Schema.Struct({
  customTitle: Schema.String,
  titleSource: Schema.optionalKey(Schema.String)
})

export const DisplayTextPayload = Schema.Struct({
  displayText: Schema.optionalKey(Schema.String),
  hookContext: Schema.optionalKey(Schema.String)
})

export const SlashCommandPayload = Schema.Struct({
  phase: Schema.optionalKey(Schema.String),
  rawCommand: Schema.optionalKey(Schema.String),
  hiddenInvocation: Schema.optionalKey(Schema.Boolean)
})

export const AtCommandPayload = Schema.Struct({
  filesRead: Schema.optionalKey(Schema.Array(Schema.String)),
  status: Schema.optionalKey(Schema.String)
})

export const TurnResultPayload = Schema.Struct({
  state: Schema.String,
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
})

export const SessionModelPayload = Schema.Struct({ modelId: Schema.String })

export const ParentSessionPayload = Schema.Struct({ parentSessionId: Schema.String })

/** `resultDisplay` of `run_shell_command` (`ShellResultDisplay`, version 1). */
export const ShellResultDisplay = Schema.Struct({
  type: Schema.tag("shell_result"),
  output: Schema.optionalKey(Schema.String),
  directory: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  signal: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  outcome: Schema.optionalKey(Schema.String)
})

/** `resultDisplay` of `edit` / `write_file` (`FileDiff`). */
export const FileDiffDisplay = Schema.Struct({
  fileDiff: Schema.optionalKey(Schema.String),
  fileName: Schema.optionalKey(Schema.String),
  filePath: Schema.optionalKey(Schema.String),
  originalContent: Schema.optionalKey(Schema.NullOr(Schema.String))
})
