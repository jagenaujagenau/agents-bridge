import {
  PiAssistantMessage,
  PiBashExecutionMessage,
  PiBranchSummary,
  PiCompaction,
  PiCustomMessage,
  PiCustomRoleMessage,
  PiToolResultMessage
} from "@agentbridge/adapter-pi"
import { Schema } from "effect"

/**
 * Provider schemas for oh-my-pi (`~/.omp/agent/sessions/<dir>/<timestamp>_<id>.jsonl`), a pi
 * derivative. The file is pi's entry tree with an omp-specific first line (a fixed-width title
 * slot rewritten in place), more entry types and more message roles. Shapes shared with pi reuse
 * pi's schemas, so pi's normalizer can handle them.
 */

const Entry = {
  id: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  timestamp: Schema.optionalKey(Schema.String)
}

/** Line 1: the current title, padded to 256 bytes and rewritten in place. */
export const OmpTitleSlot = Schema.Struct({
  type: Schema.tag("title"),
  title: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String)
})

export const OmpSessionHeader = Schema.Struct({
  type: Schema.tag("session"),
  id: Schema.String,
  version: Schema.optionalKey(Schema.Number),
  timestamp: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  /** Absolute path of the parent transcript: a fork's source, or a subagent's spawning session. */
  parentSession: Schema.optionalKey(Schema.NullOr(Schema.String))
})

/** `model` is `provider/modelId`; `role` is the model role (`default` when absent, `smol`, `fallback`, …). */
export const OmpModelChange = Schema.Struct({
  type: Schema.tag("model_change"),
  ...Entry,
  model: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String)
})

/** A model call outside the transcript (cache warm-up, classifiers). */
export const OmpModelUsage = Schema.Struct({
  type: Schema.tag("model_usage"),
  ...Entry,
  purpose: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(Schema.Unknown),
  /** The leaf at append time when the call finished after the branch moved on. */
  activeLeafId: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const OmpTitleChange = Schema.Struct({
  type: Schema.tag("title_change"),
  ...Entry,
  title: Schema.String
})

/** pi's user message plus `synthetic`: text the harness injected (e.g. auto-continue). */
export const OmpUserMessage = Schema.Struct({
  role: Schema.tag("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  synthetic: Schema.optionalKey(Schema.Boolean)
})

/** Instructions the harness added to the conversation (reminders, context). */
export const OmpDeveloperMessage = Schema.Struct({
  role: Schema.tag("developer"),
  content: Schema.optionalKey(Schema.Unknown)
})

/** Python the user ran from the prompt. */
export const OmpPythonExecutionMessage = Schema.Struct({
  role: Schema.tag("pythonExecution"),
  code: Schema.String,
  output: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cancelled: Schema.optionalKey(Schema.Boolean)
})

/** Files the user attached with `@path`; their contents went to the model. */
export const OmpFileMentionMessage = Schema.Struct({
  role: Schema.tag("fileMention"),
  files: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String })))
})

export const OmpMessage = Schema.Union([
  OmpUserMessage,
  PiAssistantMessage,
  PiToolResultMessage,
  PiBashExecutionMessage,
  PiCustomRoleMessage,
  OmpDeveloperMessage,
  OmpPythonExecutionMessage,
  OmpFileMentionMessage
])
export type OmpMessage = typeof OmpMessage.Type

export const OmpMessageEntry = Schema.Struct({
  type: Schema.tag("message"),
  ...Entry,
  message: OmpMessage
})

export const OmpRecord = Schema.Union([
  OmpTitleSlot,
  OmpSessionHeader,
  OmpModelChange,
  OmpModelUsage,
  OmpTitleChange,
  PiCompaction,
  PiBranchSummary,
  PiCustomMessage,
  OmpMessageEntry
])
export type OmpRecord = typeof OmpRecord.Type

export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "title",
  "session",
  "model_change",
  "model_usage",
  "title_change",
  "compaction",
  "branch_summary",
  "custom_message",
  "message"
])

/**
 * Entries with no canonical meaning: UI, extension and routing state. `session_init` repeats a
 * subagent's contract (its task is also its first prompt); `credential_pin` holds an account hash
 * and is never read; `reset_boundary` (`/clear`) only changes what later model calls see.
 */
export const METADATA_TYPES: ReadonlySet<string> = new Set([
  "thinking_level_change",
  "service_tier_change",
  "custom",
  "label",
  "ttsr_injection",
  "session_init",
  "mode_change",
  "credential_pin",
  "reset_boundary"
])
