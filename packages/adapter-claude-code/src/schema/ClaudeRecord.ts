import { Option, Schema } from "effect"

/**
 * Provider schemas for Claude Code `~/.claude/projects/**.jsonl` records.
 * Deliberately lenient: unknown keys are ignored and unknown content blocks
 * decode to `UnknownBlock`, so new provider fields never break a session.
 */

export const TextBlock = Schema.Struct({ type: Schema.tag("text"), text: Schema.String })
export const ThinkingBlock = Schema.Struct({ type: Schema.tag("thinking"), thinking: Schema.String })
export const ToolUseBlock = Schema.Struct({
  type: Schema.tag("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.optionalKey(Schema.Unknown)
})
export const ToolResultBlock = Schema.Struct({
  type: Schema.tag("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optionalKey(Schema.Unknown),
  is_error: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})
export const ImageBlock = Schema.Struct({
  type: Schema.tag("image"),
  source: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      media_type: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String)
    })
  )
})

export const KnownBlock = Schema.Union([TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, ImageBlock])
export type KnownBlock = typeof KnownBlock.Type
export type ClaudeBlock = KnownBlock | { readonly type: "unknown"; readonly nativeType: string }

const decodeKnownBlock = Schema.decodeUnknownOption(KnownBlock)

export const decodeBlocks = (content: string | ReadonlyArray<unknown>): ReadonlyArray<ClaudeBlock> =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map((raw) =>
      Option.getOrElse(decodeKnownBlock(raw), (): ClaudeBlock => ({
        type: "unknown",
        nativeType: typeof raw === "object" && raw !== null && "type" in raw ? String(raw.type) : "?"
      }))
    )

const RecordEnvelope = {
  uuid: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  gitBranch: Schema.optionalKey(Schema.String)
}

export const ClaudeUserRecord = Schema.Struct({
  type: Schema.tag("user"),
  ...RecordEnvelope,
  isMeta: Schema.optionalKey(Schema.Boolean),
  /** Shared by the prompt and every record of the turn it starts. */
  promptId: Schema.optionalKey(Schema.String),
  isCompactSummary: Schema.optionalKey(Schema.Boolean),
  message: Schema.Struct({
    role: Schema.String,
    content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
  }),
  toolUseResult: Schema.optionalKey(Schema.Unknown)
})
export type ClaudeUserRecord = typeof ClaudeUserRecord.Type

export const ClaudeAssistantRecord = Schema.Struct({
  type: Schema.tag("assistant"),
  ...RecordEnvelope,
  message: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    usage: Schema.optionalKey(Schema.Unknown),
    content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])
  })
})
export type ClaudeAssistantRecord = typeof ClaudeAssistantRecord.Type

export const ClaudeSystemRecord = Schema.Struct({
  type: Schema.tag("system"),
  uuid: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  durationMs: Schema.optionalKey(Schema.Number),
  content: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String)
})
export type ClaudeSystemRecord = typeof ClaudeSystemRecord.Type

export const ClaudeAiTitleRecord = Schema.Struct({ type: Schema.tag("ai-title"), aiTitle: Schema.String })
export const ClaudeCustomTitleRecord = Schema.Struct({ type: Schema.tag("custom-title"), customTitle: Schema.String })
export const ClaudeSummaryRecord = Schema.Struct({ type: Schema.tag("summary"), summary: Schema.String })
export const ClaudeContinuedInRecord = Schema.Struct({
  type: Schema.tag("continued-in"),
  continuedInSessionId: Schema.String
})

/** Record types that carry UI or bookkeeping state and have no canonical meaning. */
export const METADATA_RECORD_TYPES: ReadonlySet<string> = new Set([
  "last-prompt",
  "agent-name",
  "atis-latch",
  "queue-operation",
  "permission-mode",
  "mode",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "bridge-session",
  "pr-link",
  "tag",
  "cost-state",
  "frame-link",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger"
])

/** Structured `toolUseResult` payloads the normalizer relies on. */
export const BashResult = Schema.Struct({
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  interrupted: Schema.optionalKey(Schema.Boolean)
})

export const StructuredPatchHunk = Schema.Struct({
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
  lines: Schema.Array(Schema.String)
})

export const FileWriteResult = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  filePath: Schema.optionalKey(Schema.String),
  structuredPatch: Schema.optionalKey(Schema.Array(StructuredPatchHunk))
})

export const SubagentSidecar = Schema.Struct({
  agentType: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String)
})

export const ClaudeRecord = Schema.Union([
  ClaudeUserRecord,
  ClaudeAssistantRecord,
  ClaudeSystemRecord,
  ClaudeAiTitleRecord,
  ClaudeCustomTitleRecord,
  ClaudeSummaryRecord,
  ClaudeContinuedInRecord
])
export type ClaudeRecord = typeof ClaudeRecord.Type

export const RecordType = Schema.Struct({ type: Schema.String })
