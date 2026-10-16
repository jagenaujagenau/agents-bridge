import {
  type DecodedRecord,
  type Emission,
  endTurn,
  makeLineDecoder,
  planEntries,
  RecordScope,
  startTurn,
  stringProp,
  textOf,
  titleFrom,
  warnUndecodable
} from "@agentbridge/core"
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
import type { Schema } from "effect"
import {
  type AgentTurnOutcomeRecord,
  type CompactionStateRecord,
  decodeBlocks,
  type DroidBlock,
  DroidRecord,
  KNOWN_TYPES,
  type MessageRecord,
  METADATA_TYPES,
  type SessionStartRecord,
  type TodoStateRecord
} from "./schema/DroidRecord.ts"

export const HARNESS = "droid"
export const NAME = "Factory Droid"
export const FORMAT = "droid-session-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native Droid tool names are interpreted)
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  LS: "search",
  Glob: "search",
  Grep: "search",
  WebSearch: "search",
  ToolSearch: "search",
  FetchUrl: "fetch",
  Create: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  ApplyPatch: "edit",
  Execute: "execute"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

const COMMAND_TOOLS = new Set(["Execute"])

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly commandStartedId?: EventId
}

export interface DroidState {
  readonly sessionId: SessionId
  readonly path: string
  readonly started: boolean
  readonly sawPrompt: boolean
  /** The open turn: the ID of the prompt message that started it. */
  readonly turn: string | undefined
  readonly tools: ReadonlyMap<string, OpenTool>
  /** The last successful TodoWrite, which the following `todo_state` records. */
  readonly todoWrite: ReadonlyArray<EventId> | undefined
}

export const initialState = (sessionId: SessionId, path: string): DroidState => ({
  sessionId,
  path,
  started: false,
  sawPrompt: false,
  turn: undefined,
  tools: new Map(),
  todoWrite: undefined
})

export const decodeLine = makeLineDecoder({ schema: DroidRecord, known: KNOWN_TYPES, ignored: METADATA_TYPES })

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

const NOTICE_PREFIXES: ReadonlyArray<readonly [string, NoticeKind]> = [
  ["<system-reminder>", "injected_context"],
  ["<system-notification>", "injected_context"]
]

/** Text Droid put in a user-role text block, or `undefined` if the user wrote it. */
export const noticeKindOf = (text: string): NoticeKind | undefined => {
  const trimmed = text.trimStart()
  for (const [prefix, kind] of NOTICE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return kind
  }
  return undefined
}

/** Exit status from an Execute result. Droid records it only in the result text. */
export const executeStatus = (
  text: string,
  isError: boolean
): { readonly outcome: "succeeded" | "failed" | "interrupted"; readonly exitCode?: number } => {
  const exited = [...text.matchAll(/\[Process exited with code (-?\d+)\]/g)].at(-1)?.[1] ??
    /Command failed \(exit code: (-?\d+)\)/.exec(text)?.[1]
  if (exited !== undefined) {
    const exitCode = Number(exited)
    return { outcome: exitCode === 0 && !isError ? "succeeded" : "failed", exitCode }
  }
  if (/Command timed out after/.test(text)) return { outcome: "interrupted" }
  return isError ? { outcome: "failed" } : { outcome: "succeeded" }
}

const stripExitTrailer = (text: string) =>
  text.replace(/\n?\[Process exited with code -?\d+\]\s*$/, "").replace(/^Command failed \(exit code: -?\d+\)\n?/, "")

/**
 * Parse Droid's TodoWrite list. The tool takes numbered lines with a status marker
 * (`1. [in_progress] Do X`); older versions and `todo_state` carry an array of entries.
 */
export const todoEntries = (todos: unknown): unknown => {
  if (typeof todos === "object" && todos !== null && !Array.isArray(todos) && "todos" in todos) {
    return todoEntries((todos as { todos: unknown }).todos)
  }
  if (typeof todos !== "string") return todos
  const trimmed = todos.trim()
  if (trimmed.startsWith("[")) return todos // a JSON array, decoded by planEntries
  return trimmed.split("\n").filter((line) => line.trim().length > 0).map((line) => {
    const item = line.trim().replace(/^(?:\d+[.)]\s*|[-*]\s+)/, "")
    const marked = /^\[(completed|in_progress|pending)\]\s*(.*)$/.exec(item)
    if (marked) return { content: marked[2]!.trim(), status: marked[1] }
    const box = /^\[([xX ]?)\]\s*(.*)$/.exec(item)
    if (box) return { content: box[2]!.trim(), status: box[1]!.trim() === "" ? "pending" : "completed" }
    return { content: item, status: "pending" }
  })
}

/** `agent_turn_outcome.reason` → canonical turn outcome. */
const turnOutcome = (reason: string): "completed" | "interrupted" | "failed" | "unknown" => {
  switch (reason) {
    case "completed":
    case "spec_handoff":
      return "completed"
    case "cancelled":
    case "permission_rejected":
    case "no_approver_available":
    case "process_exit":
      return "interrupted"
    case "error":
    case "structured_output_missing":
    case "structured_output_invalid":
    case "structured_output_schema_invalid":
    case "model_usage_exhausted":
    case "model_authentication_failed":
    case "model_request_rejected":
    case "model_provider_unreachable":
    case "model_provider_unavailable":
    case "model_rate_limited":
    case "prompt_rejected":
    case "completion_persistence_failed":
      return "failed"
    default:
      return "unknown"
  }
}

const timestampOf = (value: string | number | undefined): string | undefined =>
  typeof value === "number" ? (Number.isFinite(value) ? new Date(value).toISOString() : undefined) : value

const asJson = (value: unknown) => value as Schema.Json

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [DroidState, ReadonlyArray<Emission>]

export const normalizeLine = (state: DroidState, line: DecodedRecord<DroidRecord>): Step => {
  if (line._tag === "Skip") return [state, []]
  const base = { harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.path, recordIndex: line.index }
  if (line._tag !== "Record") {
    const s = new RecordScope(base)
    warnUndecodable(s, line, NAME)
    return [state, s.emissions]
  }
  const record = line.record
  const scope = (nativeEventId: string | undefined, timestamp: string | undefined) =>
    new RecordScope({ ...base, nativeEventId, timestamp })

  switch (record.type) {
    case "session_start":
      return normalizeSessionStart(state, record, scope(undefined, undefined))
    case "message":
      return normalizeMessage(state, record, scope(record.id, timestampOf(record.timestamp)))
    case "todo_state":
      return normalizeTodoState(state, record, scope(record.id, record.timestamp))
    case "compaction_state":
      return normalizeCompaction(state, record, scope(record.id, record.timestamp))
    case "agent_turn_outcome":
      return normalizeTurnOutcome(state, record, scope(undefined, undefined))
  }
}

/** The first timestamped record starts the session; `session_start` itself has no timestamp. */
const begin = (state: DroidState, s: RecordScope): DroidState => {
  if (state.started || s.options.timestamp === undefined) return state
  s.event({ type: "session.started", certainty: "known" })
  return { ...state, started: true }
}

const normalizeSessionStart = (state: DroidState, record: SessionStartRecord, s: RecordScope): Step => {
  const fork = record.parent ?? undefined
  s.metadata({
    ...(record.cwd !== undefined ? { projectPath: record.cwd } : {}),
    ...(record.title !== undefined && record.title.trim().length > 0
      ? { title: { value: record.title, priority: record.isSessionTitleManuallySet === true ? 40 : 30 } }
      : {}),
    metadata: {
      ...(record.version !== undefined ? { sessionFormatVersion: record.version } : {}),
      ...(record.lastCwd !== undefined && record.lastCwd !== record.cwd ? { lastCwd: record.lastCwd } : {})
    },
    // `/btw` side questions name the same session as caller and fork source; the parent link covers it.
    ...(fork !== undefined && fork !== record.callingSessionId
      ? { relationships: [{ type: "fork", from: state.sessionId, to: makeSessionId(HARNESS, fork) }] }
      : {})
  })
  return [state, s.emissions]
}

const normalizeMessage = (initial: DroidState, record: MessageRecord, s: RecordScope): Step => {
  let state = begin(initial, s)
  const blocks = decodeBlocks(record.message.content)
  switch (record.message.role) {
    case "assistant":
      return [assistantBlocks(state, s, blocks), s.emissions]
    case "user":
    case "tool": {
      state = userBlocks(state, s, record, blocks)
      for (const block of blocks) {
        if (block.type === "tool_result") state = completeTool(state, s, block)
      }
      return [state, s.emissions]
    }
    default: {
      // `system` messages are harness status lines shown in the transcript.
      const content = textContent(blocks)
      if (content.length > 0) s.event({ type: "harness.notice", certainty: "known", kind: "other", content })
      return [state, s.emissions]
    }
  }
}

const textContent = (blocks: ReadonlyArray<DroidBlock>): Array<ContentBlock> =>
  blocks.flatMap((b) => (b.type === "text" && b.text.length > 0 ? [{ type: "text" as const, text: b.text }] : []))

const userBlocks = (initial: DroidState, s: RecordScope, record: MessageRecord, blocks: ReadonlyArray<DroidBlock>): DroidState => {
  let state = initial
  const texts = textContent(blocks)
  if (texts.length === 0) return state

  // Whole-message injections: hook output and model-only context.
  const wholeKind: NoticeKind | undefined = record.message.hookEventName !== undefined
    ? "hook"
    : record.message.visibility === "llm_only"
    ? "injected_context"
    : record.message.visibility === "user_only"
    ? "other"
    : undefined
  if (wholeKind !== undefined) {
    s.event({ type: "harness.notice", certainty: "known", kind: wholeKind, content: texts })
    return state
  }

  // Droid prepends `<system-reminder>` blocks to the prompt's content array.
  const prompt: Array<ContentBlock> = []
  for (const block of texts) {
    const kind = block.type === "text" ? noticeKindOf(block.text) : undefined
    if (kind !== undefined) s.event({ type: "harness.notice", certainty: "known", kind, content: [block] })
    else prompt.push(block)
  }
  if (prompt.length === 0) return state

  state = { ...state, turn: startTurn(s, state.turn, record.id) }
  s.event({ type: "user.message", certainty: "known", content: prompt })
  if (!state.sawPrompt) {
    const text = prompt.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
    s.metadata({ title: { value: titleFrom(text), priority: 10 } })
    state = { ...state, sawPrompt: true }
  }
  return state
}

const assistantBlocks = (initial: DroidState, s: RecordScope, blocks: ReadonlyArray<DroidBlock>): DroidState => {
  let state = initial
  const text: Array<ContentBlock> = []
  const flushText = () => {
    if (text.length > 0) s.event({ type: "agent.message", certainty: "known", content: text.splice(0) })
  }
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text.length > 0) text.push({ type: "text", text: block.text })
        break
      case "thinking":
        flushText()
        // Redacted or summarized-away reasoning is empty; never reconstruct it.
        if (block.thinking.trim().length > 0) {
          s.event({ type: "agent.reasoning", certainty: "known", content: block.thinking, representation: "provider_exposed" })
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
  return state
}

const startTool = (state: DroidState, s: RecordScope, block: Extract<DroidBlock, { type: "tool_use" }>): DroidState => {
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
  const command = COMMAND_TOOLS.has(block.name) ? stringProp(input, "command") : undefined
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
  tools.set(block.id, { startedId, name: block.name, input, ...(commandStartedId !== undefined ? { commandStartedId } : {}) })
  return { ...state, tools }
}

const completeTool = (state: DroidState, s: RecordScope, block: Extract<DroidBlock, { type: "tool_result" }>): DroidState => {
  const toolUseId = block.tool_use_id ?? block.toolUseId
  if (toolUseId === undefined) {
    s.warning("malformed_record", "Skipped tool results without a tool call ID")
    return state
  }
  const text = textOf(block.content)
  const failed = (block.is_error ?? block.isError) === true
  const toolCallId = toolUseId as ToolCallId
  const open = state.tools.get(toolUseId)
  if (open === undefined) {
    s.warning("orphan_tool_result", "Tool results without a matching tool call")
    return state
  }
  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: text })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId, output: text })
  const tools = new Map(state.tools)
  tools.delete(toolUseId)
  const derivedFrom = [open.startedId, resultId]

  let succeeded = !failed
  if (open.commandStartedId !== undefined) {
    const status = executeStatus(text, failed)
    succeeded = status.outcome === "succeeded"
    const stdout = stripExitTrailer(text)
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: toolUseId as CommandId,
      outcome: status.outcome,
      ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      ...(stdout.length > 0 ? { stdout } : {}),
      parentEventId: open.startedId,
      derivedFrom
    })
  }
  if (succeeded) emitFileEffects(s, open, text, derivedFrom)
  return { ...state, tools, ...(succeeded && open.name === "TodoWrite" ? { todoWrite: derivedFrom } : {}) }
}

/** ApplyPatch's result lists the files it touched: `A path`, `M path`, `D path`, `M old -> new`. */
const patchSummary = (text: string) => {
  if (!text.startsWith("Success. Applied changes to the following files:")) return undefined
  const files: Array<{ readonly op: "A" | "M" | "D"; readonly path: string; readonly movedTo?: string }> = []
  for (const line of text.split("\n").slice(1)) {
    if (line.startsWith("Failed to apply")) break
    const match = /^([AMD]) (.+?)(?: -> (.+))?$/.exec(line)
    if (match) files.push({ op: match[1] as "A" | "M" | "D", path: match[2]!, ...(match[3] !== undefined ? { movedTo: match[3] } : {}) })
  }
  return files
}

const emitFileEffects = (s: RecordScope, tool: OpenTool, resultText: string, derivedFrom: Array<EventId>) => {
  const link = { certainty: "known" as const, parentEventId: tool.startedId, derivedFrom }
  const path = stringProp(tool.input, "file_path")
  switch (tool.name) {
    case "Read":
      if (path !== undefined) s.event({ type: "file.read", path, ...link })
      return
    case "Edit":
    case "MultiEdit":
      if (path !== undefined) s.event({ type: "file.changed", path, ...link })
      return
    case "Create":
      // Create overwrites an existing file and reports "created" either way.
      if (path !== undefined) s.event({ type: "file.created", path, ...link, certainty: "inferred" })
      return
    case "ApplyPatch": {
      for (const file of patchSummary(resultText) ?? []) {
        if (file.op === "A") s.event({ type: "file.created", path: file.path, ...link })
        else if (file.op === "D") s.event({ type: "file.deleted", path: file.path, ...link })
        else if (file.movedTo !== undefined) s.event({ type: "file.changed", path: file.movedTo, previousPath: file.path, ...link })
        else s.event({ type: "file.changed", path: file.path, ...link })
      }
      return
    }
  }
}

const normalizeTodoState = (initial: DroidState, record: TodoStateRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  // Each successful TodoWrite is persisted again as `todo_state`; the plan is read from here only.
  const entries = planEntries(todoEntries(record.todos), "content")
  if (entries === undefined) {
    s.warning("malformed_record", "Skipped malformed plan updates")
    return [state, s.emissions]
  }
  const link = state.todoWrite !== undefined ? { parentEventId: state.todoWrite[0]!, derivedFrom: state.todoWrite } : {}
  s.event({ type: "plan.updated", certainty: "known", entries, ...link })
  return [{ ...state, todoWrite: undefined }, s.emissions]
}

const normalizeCompaction = (initial: DroidState, record: CompactionStateRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  s.event({
    type: "context.compacted",
    certainty: "known",
    ...(record.summaryText !== undefined && record.summaryText.length > 0 ? { summary: record.summaryText } : {})
  })
  return [state, s.emissions]
}

const normalizeTurnOutcome = (state: DroidState, record: AgentTurnOutcomeRecord, s: RecordScope): Step => {
  // Only the open turn can end; an outcome for another prompt (rewound or copied by a fork) is history.
  if (state.turn === undefined || state.turn !== record.turnId) return [state, []]
  return [{ ...state, turn: endTurn(s, state.turn, turnOutcome(record.reason)) }, s.emissions]
}
