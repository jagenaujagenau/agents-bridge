import { type Emission, emitPlan, planList, RecordScope, tokenCount, usageFields } from "@agentbridge/core"
import {
  type CommandId,
  type ContentBlock,
  type EventId,
  makeSessionId,
  type NoticeKind,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import { Option, Schema } from "effect"
import type { DecodedLine } from "./ClaudeCodeSource.ts"
import {
  BashResult,
  type ClaudeAssistantRecord,
  type ClaudeBlock,
  type ClaudeSystemRecord,
  type ClaudeUserRecord,
  decodeBlocks,
  FileWriteResult
} from "./schema/ClaudeRecord.ts"

export const HARNESS = "claude-code"
export const FORMAT = "claude-code-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native Claude tool names are interpreted)
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebSearch: "search",
  ToolSearch: "search",
  WebFetch: "fetch",
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  KillBash: "execute",
  PowerShell: "execute"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

const COMMAND_TOOLS = new Set(["Bash", "PowerShell"])

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly commandStartedId?: EventId
}

interface PendingUsage {
  readonly messageId: string
  readonly index: number
  readonly uuid: string
  readonly timestamp: string | undefined
  readonly model: string | undefined
  readonly usage: unknown
}

export interface ClaudeState {
  readonly sessionId: SessionId
  readonly path: string
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly tools: ReadonlyMap<string, OpenTool>
  readonly turn: { readonly id: string; readonly interrupted: boolean } | undefined
  /** One API message spans several lines, each repeating its usage; emit it once, after the last. */
  readonly pendingUsage: PendingUsage | undefined
  /** A `!cmd` the user ran, waiting for its output record. */
  readonly userShell: CommandId | undefined
}

export const initialState = (sessionId: SessionId, path: string): ClaudeState => ({
  sessionId,
  path,
  started: false,
  sawPrompt: false,
  tools: new Map(),
  turn: undefined,
  pendingUsage: undefined,
  userShell: undefined
})

// ---------------------------------------------------------------------------
// Text classification
// ---------------------------------------------------------------------------

type UserText =
  | { readonly _tag: "Prompt"; readonly text: string }
  | { readonly _tag: "Notice"; readonly kind: NoticeKind }

const NOTICE_PREFIXES: ReadonlyArray<readonly [string, NoticeKind]> = [
  ["<local-command-stdout>", "command_output"],
  ["<local-command-stderr>", "command_output"],
  ["<bash-stdout>", "command_output"],
  ["<bash-stderr>", "command_output"],
  ["<local-command-caveat>", "injected_context"],
  ["<system-reminder>", "injected_context"],
  ["<task-notification", "task_notification"],
  ["<user-prompt-submit-hook>", "hook"],
  ["[Request interrupted by user", "interruption"]
]

export const classifyUserText = (text: string, isMeta: boolean): UserText => {
  const trimmed = text.trimStart()
  for (const [prefix, kind] of NOTICE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return { _tag: "Notice", kind }
  }
  if (isMeta) return { _tag: "Notice", kind: "injected_context" }
  // `!cmd` typed by the user in the prompt box.
  const bashInput = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(trimmed)
  if (bashInput) return { _tag: "Prompt", text: `!${bashInput[1]!.trim()}` }
  const commandName = /<command-name>([^<]*)<\/command-name>/.exec(trimmed)
  if (commandName) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed)?.[1]?.trim()
    const name = commandName[1]!.trim()
    return { _tag: "Prompt", text: args ? `${name} ${args}` : name }
  }
  return { _tag: "Prompt", text }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decodeBash = Schema.decodeUnknownOption(BashResult)
const decodeFileWrite = Schema.decodeUnknownOption(FileWriteResult)

const resultText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .flatMap((part) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []
      )
      .join("\n")
  }
  return ""
}

const stringField = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

const renderPatch = (
  hunks: ReadonlyArray<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: ReadonlyArray<string> }>
): string | undefined =>
  hunks.length === 0
    ? undefined
    : hunks
      .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`)
      .join("")

const asJson = (value: unknown) => value as Schema.Json

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [ClaudeState, ReadonlyArray<Emission>]

/** Usage of the last API message, emitted once no further lines of it follow. */
const flushUsage = (state: ClaudeState): Step => {
  const pending = state.pendingUsage
  if (pending === undefined) return [state, []]
  const s = new RecordScope({
    harness: HARNESS,
    sessionId: state.sessionId,
    format: FORMAT,
    path: state.path,
    recordIndex: pending.index,
    nativeEventId: pending.uuid,
    timestamp: pending.timestamp
  })
  const u = pending.usage as Record<string, unknown> | undefined
  const details = u?.["output_tokens_details"] as Record<string, unknown> | undefined
  const fields = usageFields({
    model: pending.model,
    inputTokens: tokenCount(u?.["input_tokens"]),
    cacheReadTokens: tokenCount(u?.["cache_read_input_tokens"]),
    cacheWriteTokens: tokenCount(u?.["cache_creation_input_tokens"]),
    outputTokens: tokenCount(u?.["output_tokens"]),
    reasoningTokens: tokenCount(details?.["thinking_tokens"])
  })
  if (Object.keys(fields).some((key) => key !== "model")) s.event({ type: "usage.recorded", certainty: "known", ...fields })
  return [{ ...state, pendingUsage: undefined }, s.emissions]
}

export const normalizeLine = (initial: ClaudeState, line: DecodedLine): Step => {
  const continues = line._tag === "Record" && line.record.type === "assistant" &&
    line.record.message.id !== undefined && line.record.message.id === initial.pendingUsage?.messageId
  const [state, flushed] = continues || line._tag === "Blank" || line._tag === "Metadata" ? [initial, []] as Step : flushUsage(initial)
  const [next, emissions] = normalizeRecordLine(state, line)
  return [next, flushed.length === 0 ? emissions : [...flushed, ...emissions]]
}

export const onHalt = (state: ClaudeState): ReadonlyArray<Emission> => flushUsage(state)[1]

const normalizeRecordLine = (state: ClaudeState, line: DecodedLine): Step => {
  const scope = (nativeEventId?: string, timestamp?: string, version?: string) =>
    new RecordScope({
      harness: HARNESS,
      sessionId: state.sessionId,
      format: FORMAT,
      path: state.path,
      recordIndex: line.index,
      nativeEventId,
      timestamp,
      version
    })

  switch (line._tag) {
    case "Blank":
    case "Metadata":
      return [state, []]
    case "Malformed": {
      const s = scope()
      s.warning(
        line.reason === "json" ? "malformed_json" : "malformed_record",
        line.reason === "json"
          ? "Skipped lines that are not valid JSON"
          : `Skipped records that do not match the expected ${line.nativeType ?? "record"} shape`
      )
      return [state, s.emissions]
    }
    case "Unknown": {
      const s = scope()
      s.warning("unknown_record_type", `Ignored unknown Claude Code record type "${line.nativeType}"`)
      return [state, s.emissions]
    }
    case "Record":
      break
  }

  const record = line.record
  switch (record.type) {
    case "ai-title": {
      const s = scope()
      s.metadata({ title: { value: record.aiTitle, priority: 30 } })
      return [state, s.emissions]
    }
    case "custom-title": {
      const s = scope()
      s.metadata({ title: { value: record.customTitle, priority: 40 } })
      return [state, s.emissions]
    }
    case "summary": {
      const s = scope()
      s.metadata({ title: { value: record.summary, priority: 20 } })
      return [state, s.emissions]
    }
    case "continued-in": {
      const s = scope()
      s.metadata({
        relationships: [{
          type: "resume",
          from: makeSessionId(HARNESS, record.continuedInSessionId),
          to: state.sessionId
        }]
      })
      return [state, s.emissions]
    }
    case "system":
      return normalizeSystem(state, record, scope(record.uuid, record.timestamp, record.version))
    case "user":
      return normalizeUser(state, record, scope(record.uuid, record.timestamp, record.version))
    case "assistant":
      return normalizeAssistant(state, record, scope(record.uuid, record.timestamp, record.version))
  }
}

const begin = (state: ClaudeState, s: RecordScope, record: { cwd?: string; version?: string; gitBranch?: string }) => {
  if (record.cwd !== undefined || record.version !== undefined || record.gitBranch !== undefined) {
    s.metadata({
      ...(record.cwd !== undefined && !state.started ? { projectPath: record.cwd } : {}),
      ...(record.version !== undefined ? { harnessVersion: record.version } : {}),
      ...(record.gitBranch !== undefined ? { metadata: { gitBranch: record.gitBranch } } : {})
    })
  }
  if (state.started || s.options.timestamp === undefined) return state
  s.event({ type: "session.started", certainty: "known" })
  return { ...state, started: true }
}

const normalizeSystem = (state: ClaudeState, record: ClaudeSystemRecord, s: RecordScope): Step => {
  let next = begin(state, s, record)
  if (record.subtype === "compact_boundary") s.event({ type: "context.compacted", certainty: "known" })
  if (record.subtype === "turn_duration" && next.turn !== undefined) {
    s.event({
      type: "turn.completed",
      certainty: "known",
      turnId: next.turn.id,
      outcome: next.turn.interrupted ? "interrupted" : "completed",
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {})
    })
    next = { ...next, turn: undefined }
  }
  return [next, s.emissions]
}

/** A new prompt closes a turn whose end was not recorded. */
const startTurn = (state: ClaudeState, s: RecordScope, turnId: string): ClaudeState => {
  if (state.turn !== undefined) {
    s.event({ type: "turn.completed", certainty: "inferred", turnId: state.turn.id, outcome: state.turn.interrupted ? "interrupted" : "unknown" })
  }
  s.event({ type: "turn.started", certainty: "known", turnId })
  return { ...state, turn: { id: turnId, interrupted: false } }
}

/** `!cmd` typed in the prompt box, and its output. Returns undefined for other text. */
const userShell = (state: ClaudeState, s: RecordScope, uuid: string, text: string): ClaudeState | undefined => {
  const input = /^\s*<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)
  if (input) {
    const commandId = uuid as CommandId
    s.event({ type: "command.started", certainty: "known", commandId, command: input[1]!.trim() })
    return { ...state, userShell: commandId }
  }
  if (state.userShell === undefined || !/^\s*<bash-std(?:out|err)>/.test(text)) return undefined
  const stdout = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(text)?.[1]
  const stderr = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(text)?.[1]
  // Claude records no exit status for user shell commands.
  s.event({
    type: "command.completed",
    certainty: "known",
    commandId: state.userShell,
    outcome: "unknown",
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {})
  })
  return { ...state, userShell: undefined }
}

const normalizeUser = (initial: ClaudeState, record: ClaudeUserRecord, s: RecordScope): Step => {
  let state = begin(initial, s, record)
  const blocks = decodeBlocks(record.message.content)
  const content: Array<ContentBlock> = []
  for (const block of blocks) {
    if (block.type === "text") content.push({ type: "text", text: block.text })
    if (block.type === "image") {
      const uri = block.source?.url
      if (uri !== undefined) {
        content.push({ type: "image", uri, ...(block.source?.media_type ? { mimeType: block.source.media_type } : {}) })
      }
    }
  }

  if (content.length > 0) {
    const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
    const shell = record.isCompactSummary === true ? undefined : userShell(state, s, record.uuid, text)
    if (shell !== undefined) {
      state = shell
    } else if (record.isCompactSummary === true) {
      s.event({ type: "context.compacted", certainty: "known", summary: text })
    } else {
      const classified = classifyUserText(text, record.isMeta === true)
      if (classified._tag === "Notice") {
        if (classified.kind === "interruption" && state.turn !== undefined) state = { ...state, turn: { ...state.turn, interrupted: true } }
        s.event({ type: "harness.notice", certainty: "known", kind: classified.kind, content })
      } else {
        state = startTurn(state, s, record.promptId ?? record.uuid)
        const prompt: Array<ContentBlock> = classified.text === text
          ? content
          : [{ type: "text", text: classified.text }, ...content.filter((b) => b.type !== "text")]
        s.event({ type: "user.message", certainty: "known", content: prompt })
        if (!state.sawPrompt) {
          s.metadata({ title: { value: firstLine(classified.text), priority: 10 } })
          state = { ...state, sawPrompt: true }
        }
      }
    }
  }

  for (const block of blocks) {
    if (block.type === "tool_result") state = completeTool(state, s, block, record.toolUseResult)
  }
  return [state, s.emissions]
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

const normalizeAssistant = (initial: ClaudeState, record: ClaudeAssistantRecord, s: RecordScope): Step => {
  let state = begin(initial, s, record)
  if (record.message.model !== undefined) s.metadata({ metadata: { model: record.message.model } })
  if (record.message.usage !== undefined && record.message.id !== undefined) {
    state = {
      ...state,
      pendingUsage: {
        messageId: record.message.id,
        index: s.options.recordIndex,
        uuid: record.uuid,
        timestamp: record.timestamp,
        model: record.message.model,
        usage: record.message.usage
      }
    }
  }
  const text: Array<ContentBlock> = []
  const flushText = () => {
    if (text.length > 0) s.event({ type: "agent.message", certainty: "known", content: text.splice(0) })
  }
  for (const block of decodeBlocks(record.message.content)) {
    switch (block.type) {
      case "text":
        if (block.text.length > 0) text.push({ type: "text", text: block.text })
        break
      case "thinking":
        flushText()
        // Redacted thinking arrives with an empty string; never reconstruct it.
        if (block.thinking.trim().length > 0) {
          s.event({
            type: "agent.reasoning",
            certainty: "known",
            content: block.thinking,
            representation: "provider_exposed"
          })
        }
        break
      case "tool_use":
        flushText()
        state = startTool(state, s, block)
        break
      default:
        flushText()
        break
    }
  }
  flushText()
  return [state, s.emissions]
}

const startTool = (
  state: ClaudeState,
  s: RecordScope,
  block: Extract<ClaudeBlock, { type: "tool_use" }>
): ClaudeState => {
  const input = block.input
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: block.id as ToolCallId,
    name: block.name,
    kind: toolKind(block.name),
    ...(input !== undefined ? { input: asJson(input) } : {})
  })
  let commandStartedId: EventId | undefined
  const command = COMMAND_TOOLS.has(block.name) ? stringField(input, "command") : undefined
  if (command !== undefined) {
    commandStartedId = s.event({
      type: "command.started",
      certainty: "known",
      commandId: block.id as CommandId,
      command,
      parentEventId: startedId,
      derivedFrom: [startedId]
    })
  }
  const tools = new Map(state.tools)
  tools.set(block.id, {
    startedId,
    name: block.name,
    input,
    ...(commandStartedId !== undefined ? { commandStartedId } : {})
  })
  return { ...state, tools }
}

const completeTool = (
  state: ClaudeState,
  s: RecordScope,
  block: Extract<ClaudeBlock, { type: "tool_result" }>,
  toolUseResult: unknown
): ClaudeState => {
  const open = state.tools.get(block.tool_use_id)
  const text = resultText(block.content)
  const failed = block.is_error === true
  const toolCallId = block.tool_use_id as ToolCallId

  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: text })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId, output: text })

  if (open === undefined) {
    s.warning("orphan_tool_result", "Tool results without a matching tool call")
    return state
  }
  const tools = new Map(state.tools)
  tools.delete(block.tool_use_id)
  const derivedFrom = [open.startedId, resultId]

  if (open.commandStartedId !== undefined) {
    const bash = Option.getOrUndefined(decodeBash(toolUseResult))
    const exitCode = failed ? /^(?:Error: )?Exit code (\d+)/.exec(text)?.[1] : undefined
    const outcome = bash?.interrupted === true ? "interrupted" : failed ? "failed" : "succeeded"
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: block.tool_use_id as CommandId,
      outcome,
      ...(exitCode !== undefined ? { exitCode: Number(exitCode) } : {}),
      ...(bash?.stdout !== undefined ? { stdout: bash.stdout } : failed ? { stdout: stripExitHeader(text) } : {}),
      ...(bash?.stderr !== undefined ? { stderr: bash.stderr } : {}),
      parentEventId: open.startedId,
      derivedFrom
    })
  }

  if (!failed) {
    if (open.name === "TodoWrite") emitPlan(s, planList(open.input, "todos"), "content", { certainty: "known", parentEventId: open.startedId, derivedFrom })
    emitFileEffects(s, open, toolUseResult, derivedFrom)
  }
  return { ...state, tools }
}

const stripExitHeader = (text: string) => text.replace(/^(?:Error: )?Exit code \d+\n?/, "")

const emitFileEffects = (s: RecordScope, tool: OpenTool, toolUseResult: unknown, derivedFrom: Array<EventId>) => {
  const link = { certainty: "known" as const, parentEventId: tool.startedId, derivedFrom }
  switch (tool.name) {
    case "Read":
    case "NotebookRead": {
      const path = stringField(tool.input, "file_path") ?? stringField(tool.input, "notebook_path")
      if (path !== undefined) s.event({ type: "file.read", path, ...link })
      return
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const result = Option.getOrUndefined(decodeFileWrite(toolUseResult))
      const path = result?.filePath ?? stringField(tool.input, "file_path") ?? stringField(tool.input, "notebook_path")
      if (path === undefined) return
      const diff = result?.structuredPatch ? renderPatch(result.structuredPatch) : undefined
      const withDiff = diff !== undefined ? { diff } : {}
      if (result?.type === "create") s.event({ type: "file.created", path, ...withDiff, ...link })
      else s.event({ type: "file.changed", path, ...withDiff, ...link })
      return
    }
  }
}
