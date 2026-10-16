import {
  type DecodedRecord,
  type Emission,
  emitPlan,
  endTurn,
  makeLineDecoder,
  planList,
  RecordScope,
  startTurn,
  stringProp,
  titleFrom,
  tokenCount,
  usageFields,
  warnUndecodable
} from "@agentbridge/core"
import {
  type CommandId,
  type CommandOutcome,
  type EventId,
  makeSessionId,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import { Option, Schema } from "effect"
import {
  AtCommandPayload,
  CustomTitlePayload,
  DisplayTextPayload,
  FileDiffDisplay,
  IGNORED_SYSTEM_SUBTYPES,
  KNOWN_TYPES,
  ParentSessionPayload,
  QwenPart,
  QwenRecord,
  type QwenUsage,
  SessionModelPayload,
  ShellResultDisplay,
  SIDE_SUBTYPES,
  SlashCommandPayload,
  TurnResultPayload
} from "./schema/QwenRecord.ts"

export const HARNESS = "qwen-code"
export const NAME = "Qwen Code"
export const FORMAT = "qwen-code-chat-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (packages/core/src/tools/tool-names.ts, plus legacy aliases)
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  read_file: "read",
  read_many_files: "read",
  edit: "edit",
  replace: "edit",
  write_file: "edit",
  notebook_edit: "edit",
  run_shell_command: "execute",
  glob: "search",
  grep_search: "search",
  search_file_content: "search",
  list_directory: "search",
  web_search: "search",
  tool_search: "search",
  lsp: "search",
  web_fetch: "fetch",
  read_mcp_resource: "fetch",
  todo_write: "think",
  enter_plan_mode: "think",
  exit_plan_mode: "think"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

export const decodeLine = makeLineDecoder({ schema: QwenRecord, known: KNOWN_TYPES, ignored: new Set() })

const decodePart = Schema.decodeUnknownOption(QwenPart)
const decodeShell = Schema.decodeUnknownOption(ShellResultDisplay)
const decodeFileDiff = Schema.decodeUnknownOption(FileDiffDisplay)
const decodeTitle = Schema.decodeUnknownOption(CustomTitlePayload)
const decodeDisplay = Schema.decodeUnknownOption(DisplayTextPayload)
const decodeSlash = Schema.decodeUnknownOption(SlashCommandPayload)
const decodeAt = Schema.decodeUnknownOption(AtCommandPayload)
const decodeTurnResult = Schema.decodeUnknownOption(TurnResultPayload)
const decodeSessionModel = Schema.decodeUnknownOption(SessionModelPayload)
const decodeParentSession = Schema.decodeUnknownOption(ParentSessionPayload)

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly uuid: string
  readonly parentUuid: string | undefined
  /** Written beside the conversation without moving its tail. */
  readonly side: boolean
}

/**
 * Qwen Code resumes from the last conversation record and walks `parentUuid`
 * back to the root (`prepareTranscriptRecords`). `/rewind` points the next
 * record at an earlier one, leaving the rewound records in the file on a dead
 * branch. Returns the active path, or `undefined` when every record is on it.
 */
export const activePath = (entries: ReadonlyArray<TreeEntry>): ReadonlySet<string> | undefined => {
  const parents = new Map<string, string | undefined>()
  let leaf: string | undefined
  for (const entry of entries) {
    if (entry.side) continue
    // Fragments of one record share a uuid; the first one carries the parent.
    if (!parents.has(entry.uuid)) parents.set(entry.uuid, entry.parentUuid)
    leaf = entry.uuid
  }
  const path = new Set<string>()
  for (let id = leaf; id !== undefined && parents.has(id) && !path.has(id); id = parents.get(id)) path.add(id)
  return path.size === parents.size ? undefined : path
}

/** Whether a decoded line belongs to the active branch. Side records and undecodable lines always do. */
export const onPath = (path: ReadonlySet<string> | undefined) => (line: DecodedRecord<QwenRecord>): boolean =>
  path === undefined || line._tag !== "Record" || SIDE_SUBTYPES.has(line.record.subtype ?? "") ||
  path.has(line.record.uuid)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly args: unknown
  readonly commandStartedId?: EventId
}

export interface QwenState {
  readonly sessionId: SessionId
  readonly path: string
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly sawCwd: boolean
  readonly sawFork: boolean
  /** The open turn, if any. */
  readonly turn: string | undefined
  readonly cwd: string | undefined
  readonly tools: ReadonlyMap<string, OpenTool>
  /** Record uuids already emitted, so repeated fragments get index-based event IDs. */
  readonly seen: ReadonlySet<string>
}

export const initialState = (sessionId: SessionId, path: string): QwenState => ({
  sessionId,
  path,
  started: false,
  sawPrompt: false,
  sawCwd: false,
  sawFork: false,
  turn: undefined,
  cwd: undefined,
  tools: new Map(),
  seen: new Set()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFERENCED_FILES = /\n?--- Content from referenced files ---[\s\S]*?(?:--- End of content ---\n?|$)/g
const INJECTED_PART = /^\s*(?:<system-reminder>[\s\S]*<\/system-reminder>|<qwen:user-prompt-submit-context>[\s\S]*<\/qwen:user-prompt-submit-context>)\s*$/

const asJson = (value: unknown) => value as Schema.Json

const partsOf = (s: RecordScope, record: QwenRecord): ReadonlyArray<QwenPart> => {
  const parts: Array<QwenPart> = []
  let malformed = false
  for (const raw of record.message?.parts ?? []) {
    const part = Option.getOrUndefined(decodePart(raw))
    if (part === undefined) malformed = true
    else parts.push(part)
  }
  if (malformed) s.warning("malformed_record", "Skipped malformed Qwen Code message parts")
  return parts
}

const visibleText = (parts: ReadonlyArray<QwenPart>) =>
  parts.flatMap((p) => (p.thought !== true && p.text !== undefined && p.functionCall === undefined ? [p.text] : []))

const payload = <A>(decode: (u: unknown) => Option.Option<A>, value: unknown): A | undefined =>
  Option.getOrUndefined(decode(value))

/**
 * Canonical usage from Gemini-shaped `usageMetadata`. Qwen Code fills it from
 * OpenAI, Anthropic and Gemini responses; in all three `promptTokenCount`
 * includes cached tokens and `totalTokenCount - promptTokenCount` is every
 * generated token, reasoning included (OpenAI folds reasoning into
 * `candidatesTokenCount`, Gemini does not, so candidates alone are ambiguous).
 */
export const usageOf = (usage: QwenUsage, model: string | undefined) => {
  const prompt = tokenCount(usage.promptTokenCount)
  const cached = tokenCount(usage.cachedContentTokenCount)
  const total = tokenCount(usage.totalTokenCount)
  const candidates = tokenCount(usage.candidatesTokenCount)
  const thoughts = tokenCount(usage.thoughtsTokenCount)
  // Without a usable total only OpenAI-compatible responses remain, whose completion count includes reasoning.
  const output = prompt !== undefined && total !== undefined && total > 0 && total >= prompt ? total - prompt : candidates
  return usageFields({
    model,
    inputTokens: prompt === undefined ? undefined : Math.max(0, prompt - (cached ?? 0)),
    cacheReadTokens: cached,
    outputTokens: output,
    reasoningTokens: thoughts !== undefined && output !== undefined && thoughts <= output ? thoughts : undefined
  })
}

/** Exit status of a `run_shell_command` result. */
export const shellStatus = (
  display: unknown,
  output: string | undefined,
  status: string
): { readonly outcome: CommandOutcome; readonly exitCode?: number; readonly stdout?: string } => {
  const shell = Option.getOrUndefined(decodeShell(display))
  if (shell !== undefined) {
    const stdout = shell.output !== undefined ? { stdout: shell.output } : {}
    if (shell.outcome === "cancelled" || shell.outcome === "timed_out") return { outcome: "interrupted", ...stdout }
    if (typeof shell.exitCode === "number" && Number.isInteger(shell.exitCode)) {
      return { outcome: shell.exitCode === 0 ? "succeeded" : "failed", exitCode: shell.exitCode, ...stdout }
    }
    if (shell.outcome === "failed") return { outcome: "failed", ...stdout }
    if (shell.outcome === "completed") return { outcome: "succeeded", ...stdout }
  }
  // Model-facing text: `Command: …\nDirectory: …\nOutput: …\nError: …\nExit Code: N\nSignal: …`.
  const stdout = output === undefined ? undefined : /^Output: ([\s\S]*?)\n^Error: /m.exec(output)?.[1]
  const out = stdout !== undefined ? { stdout } : output !== undefined ? { stdout: output } : {}
  if (status === "cancelled" || /^\[Operation Cancelled\]/.test(output ?? "")) return { outcome: "interrupted", ...out }
  const exit = output === undefined ? undefined : /^Exit Code: (-?\d+)\s*$/m.exec(output)?.[1]
  if (exit !== undefined) return { outcome: exit === "0" ? "succeeded" : "failed", exitCode: Number(exit), ...out }
  if (output !== undefined && /^Signal: (?!\(none\))/m.test(output)) return { outcome: "interrupted", ...out }
  return { outcome: status === "error" ? "failed" : "unknown", ...out }
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [QwenState, ReadonlyArray<Emission>]

export const normalizeLine = (initial: QwenState, line: DecodedRecord<QwenRecord>): Step => {
  if (line._tag === "Skip") return [initial, []]
  let state = initial
  const base = { harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.path, recordIndex: line.index }
  if (line._tag !== "Record") {
    const s = new RecordScope(base)
    warnUndecodable(s, line, NAME)
    return [state, s.emissions]
  }
  const record = line.record
  const repeated = state.seen.has(record.uuid)
  const s = new RecordScope({
    ...base,
    ...(repeated ? {} : { nativeEventId: record.uuid }),
    timestamp: record.timestamp,
    ...(record.version !== undefined ? { version: record.version } : {})
  })
  if (!repeated) state = { ...state, seen: new Set(state.seen).add(record.uuid) }

  if (!state.started) {
    s.event({ type: "session.started", certainty: "known" })
    state = { ...state, started: true }
  }
  if (!state.sawCwd && (record.cwd !== undefined || record.version !== undefined)) {
    s.metadata({
      ...(record.cwd !== undefined ? { projectPath: record.cwd } : {}),
      ...(record.version !== undefined && record.version !== "unknown" ? { harnessVersion: record.version } : {}),
      ...(record.gitBranch !== undefined ? { metadata: { gitBranch: record.gitBranch } } : {})
    })
    state = { ...state, sawCwd: true, cwd: record.cwd }
  }
  const forkedFrom = record.forkedFrom?.sessionId
  if (!state.sawFork && forkedFrom !== undefined) {
    s.metadata({ relationships: [{ type: "fork", from: state.sessionId, to: makeSessionId(HARNESS, forkedFrom) }] })
    state = { ...state, sawFork: true }
  }

  switch (record.type) {
    case "user":
      return [normalizeUser(state, s, record), s.emissions]
    case "assistant":
      return [normalizeAssistant(state, s, record), s.emissions]
    case "tool_result":
      return [normalizeToolResult(state, s, record), s.emissions]
    case "system":
      return [normalizeSystem(state, s, record), s.emissions]
  }
}

const notice = (s: RecordScope, kind: "injected_context" | "task_notification" | "error" | "other", text: string | undefined) => {
  if (text !== undefined && text.trim().length > 0) {
    s.event({ type: "harness.notice", certainty: "known", kind, content: [{ type: "text", text: text.trim() }] })
  }
}

const normalizeUser = (initial: QwenState, s: RecordScope, record: Extract<QwenRecord, { type: "user" }>): QwenState => {
  let state = initial
  const parts = partsOf(s, record)
  const display = payload(decodeDisplay, record.systemPayload)
  switch (record.subtype) {
    case undefined:
    case "realtime_message":
    case "mid_turn_user_message":
      break
    case "notification":
      notice(s, "task_notification", display?.displayText ?? visibleText(parts).join("\n"))
      return state
    case "cron":
      notice(s, "other", display?.displayText ?? visibleText(parts).join("\n"))
      return state
    case "goal_runtime":
      notice(s, "injected_context", visibleText(parts).join("\n"))
      return state
    case "agent_mention":
    case "agent_message":
      notice(s, "other", visibleText(parts).join("\n"))
      return state
    default:
      s.warning("unknown_record_type", `Ignored unknown ${NAME} record type "user/${record.subtype}"`)
      return state
  }

  // Text the harness added to the prompt (hook context, reminders) travels as separate parts.
  const typed: Array<string> = []
  for (const text of visibleText(parts)) {
    if (INJECTED_PART.test(text)) notice(s, "injected_context", text)
    else typed.push(text)
  }
  const text = (display?.displayText ?? typed.join("\n")).replace(REFERENCED_FILES, "").trim()
  if (text.length === 0) return state
  if (record.subtype !== "mid_turn_user_message") state = { ...state, turn: startTurn(s, state.turn, record.uuid) }
  s.event({ type: "user.message", certainty: "known", content: [{ type: "text", text }] })
  if (!state.sawPrompt) {
    s.metadata({ title: { value: titleFrom(text), priority: 10 } })
    state = { ...state, sawPrompt: true }
  }
  return state
}

const normalizeAssistant = (
  initial: QwenState,
  s: RecordScope,
  record: Extract<QwenRecord, { type: "assistant" }>
): QwenState => {
  let state = initial
  if (record.model !== undefined) s.metadata({ metadata: { model: record.model } })
  if (record.usageMetadata) {
    const usage = usageOf(record.usageMetadata, record.model)
    if (Object.keys(usage).some((key) => key !== "model")) s.event({ type: "usage.recorded", certainty: "known", ...usage })
  }
  const parts = partsOf(s, record)
  let text: Array<string> = []
  const flush = () => {
    const joined = text.join("").trim()
    if (joined.length > 0) s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: joined }] })
    text = []
  }
  let calls = 0
  for (const part of parts) {
    if (part.functionCall !== undefined) {
      flush()
      calls++
      state = startTool(state, s, part.functionCall, `${record.uuid}:${calls}`)
    } else if (part.thought === true) {
      flush()
      if (part.text !== undefined && part.text.trim().length > 0) {
        s.event({ type: "agent.reasoning", certainty: "known", content: part.text.trim(), representation: "provider_exposed" })
      }
    } else if (part.text !== undefined) {
      text.push(part.text)
    }
  }
  flush()
  // Qwen Code records no turn end in the CLI; a model call that requests no tools is where it stopped.
  // Subagent transcripts split text and calls into separate records, so they get no inferred end.
  if (calls === 0 && parts.length > 0 && record.isSidechain !== true) {
    state = { ...state, turn: endTurn(s, state.turn, "completed", { certainty: "inferred" }) }
  }
  return state
}

const startTool = (
  state: QwenState,
  s: RecordScope,
  call: NonNullable<QwenPart["functionCall"]>,
  fallbackId: string
): QwenState => {
  const id = call.id ?? fallbackId
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: id as ToolCallId,
    name: call.name,
    kind: toolKind(call.name),
    ...(call.args !== undefined ? { input: asJson(call.args) } : {})
  })
  const command = call.name === "run_shell_command" ? stringProp(call.args, "command") : undefined
  const cwd = stringProp(call.args, "directory") ?? state.cwd
  const commandStartedId = command === undefined ? undefined : s.event({
    type: "command.started",
    certainty: "known",
    commandId: id as CommandId,
    command,
    ...(cwd !== undefined ? { cwd } : {}),
    parentEventId: startedId,
    derivedFrom: [startedId]
  })
  const tools = new Map(state.tools).set(id, {
    startedId,
    name: call.name,
    args: call.args,
    ...(commandStartedId !== undefined ? { commandStartedId } : {})
  })
  return { ...state, tools }
}

const responseText = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : typeof value === "string" ? value : JSON.stringify(value)

const normalizeToolResult = (
  initial: QwenState,
  s: RecordScope,
  record: Extract<QwenRecord, { type: "tool_result" }>
): QwenState => {
  // Nested calls of a code-mode `exec` script: the outer call's result already reports them.
  if (record.subtype === "code_mode_tool_result") return initial
  let state = initial
  const meta = record.toolCallResult ?? undefined
  const responses = partsOf(s, record).flatMap((p) => (p.functionResponse !== undefined ? [p.functionResponse] : []))
  if (responses.length === 0 && meta?.callId === undefined) {
    s.warning("malformed_record", "Skipped Qwen Code tool results without a function response")
    return state
  }
  for (const response of responses.length > 0 ? responses : [{ id: meta?.callId }]) {
    const callId = response.id ?? meta?.callId
    const open = callId === undefined ? undefined : state.tools.get(callId)
    if (callId === undefined || open === undefined) {
      s.warning("orphan_tool_result", "Tool results without a matching tool call")
      continue
    }
    const body = "response" in response ? response.response : undefined
    const error = responseText(body?.["error"])
    const output = responseText(body?.["output"]) ?? error
    // Subagent transcripts omit the status; an `error` response is how the model saw a failure.
    const status = meta?.callId === callId && meta.status !== undefined ? meta.status : error !== undefined ? "error" : "success"
    const display = meta?.callId === callId ? meta.resultDisplay : undefined
    const toolCallId = callId as ToolCallId
    const failed = status !== "success"
    const resultId = failed
      ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: error ?? output ?? status })
      : s.event({ type: "tool.completed", certainty: "known", toolCallId, ...(output !== undefined ? { output } : {}) })
    const tools = new Map(state.tools)
    tools.delete(callId)
    state = { ...state, tools }
    const link = { parentEventId: open.startedId, derivedFrom: [open.startedId, resultId] }

    if (open.commandStartedId !== undefined) {
      const background = (open.args as { is_background?: unknown } | undefined)?.is_background === true
      const result = background && !failed ? { outcome: "unknown" as const } : shellStatus(display, output, status)
      s.event({ type: "command.completed", certainty: "known", commandId: callId as CommandId, ...result, ...link })
    }
    if (failed) continue
    if (open.name === "todo_write") emitPlan(s, planList(open.args, "todos"), "content", { certainty: "known", ...link })
    const path = stringProp(open.args, "file_path", "absolute_path")
    if (path === undefined) continue
    switch (open.name) {
      case "read_file":
        s.event({ type: "file.read", certainty: "known", path, ...link })
        break
      case "edit":
      case "replace":
      case "write_file": {
        const diff = Option.getOrUndefined(decodeFileDiff(display))
        const created = /^(?:Created new file|Successfully created and wrote to new file)/.test(output ?? "") ||
          diff?.originalContent === null
        const patch = diff?.fileDiff !== undefined ? { diff: diff.fileDiff } : {}
        s.event({ type: created ? "file.created" : "file.changed", certainty: "known", path, ...patch, ...link })
        break
      }
    }
  }
  return state
}

const normalizeSystem = (
  initial: QwenState,
  s: RecordScope,
  record: Extract<QwenRecord, { type: "system" }>
): QwenState => {
  let state = initial
  const subtype = record.subtype ?? ""
  if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) return state
  switch (subtype) {
    case "custom_title": {
      const title = payload(decodeTitle, record.systemPayload)
      // Legacy records without a source were manual renames.
      if (title?.customTitle.trim()) {
        s.metadata({ title: { value: title.customTitle.trim(), priority: title.titleSource === "auto" ? 30 : 40 } })
      }
      return state
    }
    case "session_model": {
      const model = payload(decodeSessionModel, record.systemPayload)
      if (model !== undefined) s.metadata({ metadata: { model: model.modelId } })
      return state
    }
    case "parent_session": {
      const parent = payload(decodeParentSession, record.systemPayload)
      if (parent !== undefined) {
        s.metadata({ relationships: [{ type: "child", from: state.sessionId, to: makeSessionId(HARNESS, parent.parentSessionId) }] })
      }
      return state
    }
    case "chat_compression":
      s.event({ type: "context.compacted", certainty: "known" })
      return state
    case "slash_command": {
      const command = payload(decodeSlash, record.systemPayload)
      if (command?.phase === "invocation" && command.hiddenInvocation !== true) notice(s, "other", command.rawCommand)
      return state
    }
    case "at_command": {
      const at = payload(decodeAt, record.systemPayload)
      if (at?.status === "success") for (const path of at.filesRead ?? []) s.event({ type: "file.read", certainty: "known", path })
      return state
    }
    case "background_task_completed":
      notice(s, "task_notification", payload(decodeDisplay, record.systemPayload)?.displayText)
      return state
    case "turn_result": {
      const result = payload(decodeTurnResult, record.systemPayload)
      if (result === undefined) {
        s.warning("malformed_record", "Skipped malformed Qwen Code turn results")
        return state
      }
      if (result.state === "error") notice(s, "error", result.error?.message ?? "The turn failed")
      const outcome = result.state === "completed" ? "completed" : result.state === "cancelled" ? "interrupted" : "failed"
      return { ...state, turn: endTurn(s, state.turn, outcome) }
    }
    default:
      s.warning("unknown_record_type", `Ignored unknown ${NAME} record type "system/${subtype}"`)
      return state
  }
}
