import {
  type DecodedRecord,
  type Emission,
  endTurn,
  makeLineDecoder,
  type MetadataPatch,
  RecordScope,
  startTurn,
  stringProp,
  titleFrom,
  warnUndecodable
} from "@agentbridge/core"
import {
  type CommandId,
  type CommandOutcome,
  type ContentBlock,
  type EventId,
  makeSessionId,
  type NoticeKind,
  type PlanEntry,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import type { Schema } from "effect"
import {
  type ContentBlock as GrokContentBlock,
  type GrokLine,
  type GrokSummary,
  type GrokUpdate,
  GrokLine as GrokLineSchema,
  IGNORED_UPDATES,
  KNOWN_UPDATES,
  type ToolCallContent,
  updateTypeOf
} from "./schema/GrokRecord.ts"

export const HARNESS = "grok"
export const NAME = "Grok Build"
export const FORMAT = "grok-updates-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native Grok tool names are interpreted)
// ---------------------------------------------------------------------------

/**
 * Grok's built-in tools (CLI 1.0.60 docs: "Tools", "Tool Name Aliases", `--tools` IDs), the
 * daemon-route client names, and the Cursor preset's names. Grok also writes an ACP `kind` on
 * each tool call; that wins when present, so this table only fills in calls recorded without it.
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  read_file: "read",
  hashline_read: "read",
  search_replace: "edit",
  hashline_edit: "edit",
  write: "edit",
  apply_patch: "edit",
  StrReplace: "edit",
  EditNotebook: "edit",
  Delete: "delete",
  grep: "search",
  hashline_grep: "search",
  list_dir: "search",
  search_tool: "search",
  web_search: "search",
  XSearch: "search",
  web_fetch: "fetch",
  run_terminal_command: "execute",
  run_terminal_cmd: "execute",
  Shell: "execute"
}

const ACP_KINDS: ReadonlySet<string> = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"])

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

/** Edit tools whose input names the file, used only when the call carries no ACP diff. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write"])
const REPLACE_TOOLS: ReadonlySet<string> = new Set(["search_replace", "hashline_edit", "StrReplace"])

const asJson = (value: unknown) => value as Schema.Json

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

const NOTICE_PREFIXES: ReadonlyArray<readonly [string, NoticeKind]> = [
  ["<system-reminder>", "injected_context"],
  ["<user_info>", "injected_context"],
  ["<git_status>", "injected_context"],
  ["<monitor-event", "task_notification"]
]

/** Text Grok put in the user role (context it injects, monitor events), or `undefined` if the user wrote it. */
export const noticeKindOf = (text: string): NoticeKind | undefined => {
  const trimmed = text.trimStart().toLowerCase()
  for (const [prefix, kind] of NOTICE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return kind
  }
  return undefined
}

/** Grok's model-facing prompt wrapper; the prompt the user typed is inside. */
export const unwrapUserQuery = (text: string): string => {
  const match = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/i.exec(text)
  return match === null ? text : match[1]!.trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A run_terminal_command exit code. Grok's BashOutput carries `exit_code`; the prompt-facing
 * text ends with `Exit code: N`. Never invented: `undefined` when neither is recorded.
 */
export const exitCodeOf = (rawOutput: unknown, text: string): number | undefined => {
  const pick = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined
    const code = value["exit_code"] ?? value["exitCode"]
    return typeof code === "number" && Number.isInteger(code) ? code : undefined
  }
  const direct = pick(rawOutput)
  if (direct !== undefined) return direct
  // An externally tagged ToolOutput (`{"Bash": {...}}`) or a wrapper one level down.
  if (isRecord(rawOutput)) {
    for (const value of Object.values(rawOutput)) {
      const nested = pick(value)
      if (nested !== undefined) return nested
    }
  }
  const trailer = [...text.matchAll(/Exit code: (-?\d+)/g)].at(-1)?.[1]
  return trailer === undefined ? undefined : Number(trailer)
}

/** Text a tool returned: ACP `content` text, else a string `rawOutput`, else its prompt-facing text. */
const outputText = (content: ReadonlyArray<ToolCallContent>, rawOutput: unknown): string => {
  const text = content
    .flatMap((item) => (item.type === "content" && typeof item.content?.text === "string" ? [item.content.text] : []))
    .join("\n")
  if (text.length > 0) return text
  if (typeof rawOutput === "string") return rawOutput
  if (isRecord(rawOutput)) {
    const own = stringProp(rawOutput, "output_for_prompt", "output", "stdout", "content")
    if (own !== undefined) return own
    for (const value of Object.values(rawOutput)) {
      const nested = stringProp(value, "output_for_prompt", "output", "stdout")
      if (nested !== undefined) return nested
    }
  }
  return ""
}

const commandOf = (rawInput: unknown): string | undefined => {
  if (!isRecord(rawInput)) return undefined
  const command = rawInput["command"]
  if (typeof command === "string") return command
  if (Array.isArray(command)) return command.map(String).join(" ")
  return undefined
}

const inputPath = (rawInput: unknown): string | undefined => stringProp(rawInput, "file_path", "path", "target_file")

const timestampOf = (line: GrokLine): string | undefined => {
  const meta = line.params._meta
  const ms = meta?.["agentTimestampMs"]
  if (typeof ms === "number" && Number.isFinite(ms)) return new Date(ms).toISOString()
  const ts = line.timestamp
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(Math.round(ts * 1000)).toISOString()
  return typeof ts === "string" ? ts : undefined
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type ChunkRole = "user" | "agent" | "thought"

interface ChunkBuffer {
  readonly role: ChunkRole
  /** Which message the chunks belong to: the prompt index for user chunks, the model stream otherwise. */
  readonly identity: string | undefined
  readonly index: number
  readonly nativeEventId: string | undefined
  readonly timestamp: string | undefined
  readonly text: string
  readonly extra: ReadonlyArray<ContentBlock>
}

interface ToolState {
  readonly startedId: EventId
  readonly name: string
  readonly kind: ToolKind
  readonly rawInput: unknown
  readonly rawOutput: unknown
  readonly status: string | undefined
  readonly content: ReadonlyArray<ToolCallContent>
  readonly locations: ReadonlyArray<string>
  readonly commandStartedId: EventId | undefined
}

/** Native token totals summed over `turn_completed` records. */
type UsageTotals = Readonly<Record<string, number>>

export interface GrokState {
  readonly sessionId: SessionId
  readonly path: string
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly buffer: ChunkBuffer | undefined
  readonly tools: ReadonlyMap<string, ToolState>
  readonly finishedTools: ReadonlySet<string>
  /** The open turn's ID and the prompt index that opened it. */
  readonly turn: string | undefined
  readonly turnPrompt: string | undefined
  /** The last user chunk, to drop the client's echo of the same prompt. */
  readonly lastUserChunk: string | undefined
  readonly usage: UsageTotals
}

export const initialState = (sessionId: SessionId, path: string): GrokState => ({
  sessionId,
  path,
  started: false,
  sawPrompt: false,
  buffer: undefined,
  tools: new Map(),
  finishedTools: new Set(),
  turn: undefined,
  turnPrompt: undefined,
  lastUserChunk: undefined,
  usage: {}
})

export const decodeLine = makeLineDecoder({
  schema: GrokLineSchema,
  typeOf: updateTypeOf,
  known: KNOWN_UPDATES,
  ignored: IGNORED_UPDATES
})

type Step = readonly [GrokState, ReadonlyArray<Emission>]

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const isText = (block: GrokContentBlock) => (block.type === undefined || block.type === "text") && block.text !== undefined

const toContent = (block: GrokContentBlock): Array<ContentBlock> => {
  if (isText(block)) return [{ type: "text", text: block.text! }]
  if (block.type === "image") {
    const uri = block.uri ?? (block.data !== undefined && block.mimeType ? `data:${block.mimeType};base64,${block.data}` : undefined)
    return uri === undefined ? [] : [{ type: "image", uri, ...(block.mimeType ? { mimeType: block.mimeType } : {}) }]
  }
  if (block.type === "resource_link" && block.uri) return [{ type: "file", path: block.uri.replace(/^file:\/\//, "") }]
  if (block.type === "resource" && block.resource?.uri) return [{ type: "file", path: block.resource.uri.replace(/^file:\/\//, "") }]
  return []
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

const scopeAt = (state: GrokState, index: number, nativeEventId: string | undefined, timestamp: string | undefined) =>
  new RecordScope({ harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.path, recordIndex: index, nativeEventId, timestamp })

/** Emit buffered chunks as one message. */
const flush = (state: GrokState): Step => {
  const buffer = state.buffer
  if (buffer === undefined) return [state, []]
  let next: GrokState = { ...state, buffer: undefined }
  const s = scopeAt(state, buffer.index, buffer.nativeEventId, buffer.timestamp)
  const text = buffer.role === "user" ? unwrapUserQuery(buffer.text) : buffer.text
  const content: Array<ContentBlock> = [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...buffer.extra]
  if (content.length === 0) return [next, []]
  switch (buffer.role) {
    case "user":
      s.event({ type: "user.message", certainty: "known", content })
      if (!state.sawPrompt && text.length > 0) {
        s.metadata({ title: { value: titleFrom(text), priority: 10 } })
        next = { ...next, sawPrompt: true }
      }
      break
    case "agent":
      s.event({ type: "agent.message", certainty: "known", content })
      break
    case "thought":
      // Redacted or encrypted reasoning arrives empty; never reconstruct it.
      if (buffer.text.trim().length > 0) {
        s.event({ type: "agent.reasoning", certainty: "known", content: buffer.text, representation: "provider_exposed" })
      }
      break
  }
  return [next, s.emissions]
}

/** The first timestamped record starts the session. */
const begin = (state: GrokState, s: RecordScope): GrokState => {
  if (state.started || s.options.timestamp === undefined) return state
  s.event({ type: "session.started", certainty: "known" })
  return { ...state, started: true }
}

export const normalizeLine = (initial: GrokState, line: DecodedRecord<GrokLine>): Step => {
  if (line._tag === "Skip") return [initial, []]
  if (line._tag !== "Record") {
    const s = scopeAt(initial, line.index, undefined, undefined)
    warnUndecodable(s, line, NAME)
    return [initial, s.emissions]
  }
  const record = line.record
  const update = record.params.update
  const meta = { ...record.params._meta, ...("_meta" in update ? update._meta : undefined) }
  const eventId = typeof meta["eventId"] === "string" ? meta["eventId"] : undefined
  const timestamp = timestampOf(record)
  const scope = (state: GrokState) => scopeAt(state, line.index, eventId, timestamp)

  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return userChunk(initial, update, meta, line.index, eventId, timestamp, scope)
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const role: ChunkRole = update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought"
      const stream = meta["streamStartMs"] ?? update.messageId ?? undefined
      const identity = stream === undefined ? undefined : `${String(meta["promptId"] ?? "")}:${String(stream)}`
      return chunk(initial, role, identity, update.content, line.index, eventId, timestamp, scope)
    }
    case "tool_call":
    case "tool_call_update": {
      const [flushed, before] = flush(initial)
      const s = scope(flushed)
      const state = toolUpdate(begin(flushed, s), s, update)
      return [state, [...before, ...s.emissions]]
    }
    case "plan": {
      const [flushed, before] = flush(initial)
      const s = scope(flushed)
      const state = begin(flushed, s)
      const entries: Array<PlanEntry> = update.entries.map((entry) => ({
        content: entry.content,
        status: entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending",
        ...(entry.priority === "high" || entry.priority === "medium" || entry.priority === "low" ? { priority: entry.priority } : {})
      }))
      s.event({ type: "plan.updated", certainty: "known", entries })
      return [state, [...before, ...s.emissions]]
    }
    case "session_info_update": {
      const s = scope(initial)
      if (update.title) s.metadata({ title: { value: update.title, priority: 30 } })
      return [initial, s.emissions]
    }
    case "turn_completed": {
      const [flushed, before] = flush(initial)
      const s = scope(flushed)
      let state = begin(flushed, s)
      const reason = update.stop_reason ?? undefined
      const outcome = reason === "cancelled" ? "interrupted" : reason === "refusal" ? "failed" : reason === undefined ? "unknown" : "completed"
      state ={ ...state, turn: endTurn(s, state.turn, outcome), turnPrompt: undefined }
      // Totals per run of the agent loop, not per model call: kept as session metadata, never usage events.
      const usage = addUsage(state.usage, update.usage ?? undefined)
      if (usage !== state.usage) {
        state = { ...state, usage }
        s.metadata({ metadata: { tokenTotals: asJson(usage) } })
      }
      return [state, [...before, ...s.emissions]]
    }
    case "auto_compact_completed": {
      const [flushed, before] = flush(initial)
      const s = scope(flushed)
      const state = begin(flushed, s)
      s.event({ type: "context.compacted", certainty: "known" })
      return [state, [...before, ...s.emissions]]
    }
  }
}

const USAGE_KEYS = ["inputTokens", "outputTokens", "totalTokens", "cachedReadTokens", "cacheCreationTokens", "reasoningTokens", "modelCalls"]

const addUsage = (totals: UsageTotals, usage: Readonly<Record<string, unknown>> | undefined): UsageTotals => {
  if (usage === undefined) return totals
  let next: Record<string, number> | undefined
  for (const key of USAGE_KEYS) {
    const value = usage[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) continue
    next ??= { ...totals }
    next[key] = (next[key] ?? 0) + value
  }
  return next ?? totals
}

const userChunk = (
  initial: GrokState,
  update: Extract<GrokUpdate, { sessionUpdate: "user_message_chunk" }>,
  meta: Readonly<Record<string, unknown>>,
  index: number,
  eventId: string | undefined,
  timestamp: string | undefined,
  scope: (state: GrokState) => RecordScope
): Step => {
  const text = isText(update.content) ? update.content.text! : ""
  const promptIndex = meta["promptIndex"] === undefined ? undefined : String(meta["promptIndex"])
  // The client echoes a submitted prompt; the same chunk for the same prompt is one fact.
  const key = promptIndex === undefined ? undefined : `${promptIndex}\u0000${JSON.stringify(update.content)}`
  if (key !== undefined && key === initial.lastUserChunk) return [initial, []]

  const kind = meta["hideFromScrollback"] === true ? "injected_context" : text.length > 0 ? noticeKindOf(text) : undefined
  if (kind !== undefined) {
    const [flushed, before] = flush(initial)
    const s = scope(flushed)
    const state = begin(flushed, s)
    s.event({ type: "harness.notice", certainty: "known", kind, content: toContent(update.content) })
    return [{ ...state, lastUserChunk: key }, [...before, ...s.emissions]]
  }

  const [state, emissions] = chunk(initial, "user", promptIndex, update.content, index, eventId, timestamp, scope)
  const s = scope(state)
  let next: GrokState = { ...state, lastUserChunk: key }
  // A prompt (new prompt index, or the first prompt) opens a turn; `turn_completed` closes it.
  if (state.turn === undefined || promptIndex === undefined || promptIndex !== state.turnPrompt) {
    next = { ...next, turn: startTurn(s, state.turn, promptIndex !== undefined ? `prompt-${promptIndex}` : eventId ?? `line-${index}`), turnPrompt: promptIndex }
  }
  const model = meta["modelId"]
  if (typeof model === "string") s.metadata({ metadata: { model } })
  return [next, [...emissions, ...s.emissions]]
}

const chunk = (
  initial: GrokState,
  role: ChunkRole,
  identity: string | undefined,
  content: GrokContentBlock,
  index: number,
  eventId: string | undefined,
  timestamp: string | undefined,
  scope: (state: GrokState) => RecordScope
): Step => {
  const current = initial.buffer
  const continues = current !== undefined && current.role === role &&
    (identity === undefined || current.identity === undefined || current.identity === identity)
  const [flushed, before] = continues ? [initial, []] as Step : flush(initial)
  const s = scope(flushed)
  const state = begin(flushed, s)
  const base: ChunkBuffer = continues
    ? current!
    : { role, identity, index, nativeEventId: eventId, timestamp, text: "", extra: [] }
  const buffer: ChunkBuffer = {
    ...base,
    identity: base.identity ?? identity,
    text: base.text + (isText(content) ? content.text! : ""),
    extra: isText(content) ? base.extra : [...base.extra, ...toContent(content)]
  }
  return [{ ...state, buffer }, [...before, ...s.emissions]]
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type ToolUpdate = Extract<GrokUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>

/** Grok's own tool name: canonical tool metadata, the streamed `toolName`, else the ACP title. */
const nativeName = (update: ToolUpdate): string | undefined => {
  const canonical = update._meta?.["x.ai/tool"]
  return stringProp(canonical, "name", "tool_name") ?? update.toolName ?? update.title ?? undefined
}

const kindOf = (kind: string | null | undefined, name: string): ToolKind =>
  kind !== undefined && kind !== null && ACP_KINDS.has(kind) ? (kind as ToolKind) : toolKind(name)

const TERMINAL = new Set(["completed", "failed", "error", "cancelled", "canceled"])

const toolUpdate = (state: GrokState, s: RecordScope, update: ToolUpdate): GrokState => {
  if (state.finishedTools.has(update.toolCallId)) return state
  const toolCallId = update.toolCallId as ToolCallId
  let tool = state.tools.get(update.toolCallId)
  const existed = tool !== undefined

  if (tool === undefined) {
    const name = nativeName(update) ?? update.kind ?? "tool"
    const kind = kindOf(update.kind, name)
    const startedId = s.event({
      type: "tool.started",
      certainty: "known",
      toolCallId,
      name,
      kind,
      ...(update.rawInput !== undefined ? { input: asJson(update.rawInput) } : {})
    })
    tool = {
      startedId,
      name,
      kind,
      rawInput: update.rawInput,
      rawOutput: undefined,
      status: undefined,
      content: [],
      locations: [],
      commandStartedId: undefined
    }
  }

  // ACP merge semantics: an omitted field is kept, null clears it, arrays replace.
  const kindChanged = existed && update.kind != null && kindOf(update.kind, tool.name) !== tool.kind
  tool = {
    ...tool,
    ...(kindChanged ? { kind: kindOf(update.kind, tool.name) } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.status !== undefined ? { status: update.status ?? undefined } : {}),
    ...(update.content !== undefined ? { content: update.content ?? [] } : {}),
    ...(update.locations !== undefined ? { locations: update.locations?.map((l) => l.path) ?? [] } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {})
  }
  if (existed && (kindChanged || update.rawInput !== undefined)) {
    s.event({
      type: "tool.updated",
      certainty: "known",
      toolCallId,
      ...(kindChanged ? { kind: tool.kind } : {}),
      ...(update.rawInput !== undefined ? { input: asJson(tool.rawInput) } : {}),
      parentEventId: tool.startedId,
      derivedFrom: [tool.startedId]
    })
  }
  const command = tool.kind === "execute" ? commandOf(tool.rawInput) : undefined
  if (tool.commandStartedId === undefined && command !== undefined) {
    const cwd = stringProp(tool.rawInput, "cwd")
    const commandStartedId = s.event({
      type: "command.started",
      certainty: "known",
      commandId: update.toolCallId as CommandId,
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      parentEventId: tool.startedId,
      derivedFrom: [tool.startedId]
    })
    tool = { ...tool, commandStartedId }
  }

  const tools = new Map(state.tools)
  if (tool.status !== undefined && TERMINAL.has(tool.status)) {
    finishTool(s, update.toolCallId, tool)
    tools.delete(update.toolCallId)
    return { ...state, tools, finishedTools: new Set(state.finishedTools).add(update.toolCallId) }
  }
  tools.set(update.toolCallId, tool)
  return { ...state, tools }
}

const finishTool = (s: RecordScope, id: string, tool: ToolState) => {
  const cancelled = tool.status === "cancelled" || tool.status === "canceled"
  const failed = cancelled || tool.status === "failed" || tool.status === "error"
  const text = outputText(tool.content, tool.rawOutput)
  const toolCallId = id as ToolCallId
  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: text || (tool.status ?? "failed") })
    : s.event({
      type: "tool.completed",
      certainty: "known",
      toolCallId,
      ...(text ? { output: text } : tool.rawOutput !== undefined ? { output: asJson(tool.rawOutput) } : {})
    })
  const derivedFrom = [tool.startedId, resultId]

  let succeeded = !failed
  if (tool.commandStartedId !== undefined) {
    const exitCode = exitCodeOf(tool.rawOutput, text)
    const outcome: CommandOutcome = cancelled
      ? "interrupted"
      : exitCode !== undefined
      ? (exitCode === 0 && !failed ? "succeeded" : "failed")
      : failed
      ? "failed"
      : "succeeded"
    succeeded = outcome === "succeeded"
    const stderr = stringProp(tool.rawOutput, "stderr")
    const stdout = text.replace(/\n?Exit code: -?\d+\s*$/, "")
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: id as CommandId,
      outcome,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(stdout.length > 0 ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      parentEventId: tool.startedId,
      derivedFrom
    })
  }
  if (succeeded) emitFileEffects(s, tool, derivedFrom)
}

const emitFileEffects = (s: RecordScope, tool: ToolState, derivedFrom: Array<EventId>) => {
  const link = { certainty: "known" as const, parentEventId: tool.startedId, derivedFrom }
  // ACP diffs say which files changed and whether they existed (no old text: a new file).
  const diffs = tool.content.filter((item) => item.type === "diff" && item.path !== undefined)
  for (const diff of diffs) {
    if (diff.oldText === null || diff.oldText === undefined) s.event({ type: "file.created", path: diff.path!, ...link })
    else s.event({ type: "file.changed", path: diff.path!, ...link })
  }
  if (tool.kind === "read") {
    const paths = tool.locations.length > 0 ? tool.locations : [inputPath(tool.rawInput)].filter((p) => p !== undefined)
    for (const path of paths) s.event({ type: "file.read", path, ...link })
  }
  if (tool.kind === "delete") {
    for (const path of tool.locations) s.event({ type: "file.deleted", path, ...link })
  }
  if (diffs.length > 0 || tool.kind !== "edit") return
  // An edit recorded without a diff: the tool's input names the file.
  const path = inputPath(tool.rawInput)
  if (path === undefined) return
  if (WRITE_TOOLS.has(tool.name)) {
    // `write` creates the file or replaces it; which one is not recorded.
    s.event({ type: "file.created", path, ...link, certainty: "inferred" })
  } else if (REPLACE_TOOLS.has(tool.name)) {
    const oldString = stringProp(tool.rawInput, "old_string")
    if (oldString === "") s.event({ type: "file.created", path, ...link, certainty: "inferred" })
    else s.event({ type: "file.changed", path, ...link })
  }
}

/** Flush any message still buffered when the stream ends. */
export const onHalt = (state: GrokState): ReadonlyArray<Emission> => flush(state)[1]

// ---------------------------------------------------------------------------
// summary.json
// ---------------------------------------------------------------------------

/** A subagent's summary names its spawner; any other parent is a fork or restore source. */
export const isSubagentSummary = (summary: GrokSummary): boolean =>
  summary.session_kind === "subagent" || (summary.subagent_type != null && summary.subagent_type.length > 0)

/** Session metadata from the index entry beside the log. */
export const summaryMetadata = (summary: GrokSummary, sessionId: SessionId): MetadataPatch => {
  const title = summary.generated_title?.trim() || summary.session_summary?.trim()
  const parent = summary.parent_session_id ?? undefined
  return {
    ...(summary.info?.cwd ? { projectPath: summary.info.cwd } : {}),
    ...(title ? { title: { value: title, priority: summary.title_is_manual === true ? 40 : 30 } } : {}),
    metadata: {
      ...(summary.current_model_id ? { model: summary.current_model_id } : {}),
      ...(summary.head_branch ? { gitBranch: summary.head_branch } : {}),
      ...(summary.subagent_type ? { subagentType: summary.subagent_type } : {}),
      ...(summary.agent_name ? { agentName: summary.agent_name } : {})
    },
    ...(parent !== undefined && parent.length > 0 && !isSubagentSummary(summary) && makeSessionId(HARNESS, parent) !== sessionId
      ? { relationships: [{ type: "fork" as const, from: sessionId, to: makeSessionId(HARNESS, parent) }] }
      : {})
  }
}
