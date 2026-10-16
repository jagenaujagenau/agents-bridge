import {
  type Emission,
  endTurn,
  makeRecordDecoder,
  parseJson,
  RecordScope,
  type SourceLine,
  startTurn,
  stringProp,
  titleFrom,
  tokenCount,
  usageFields,
  warnUndecodable
} from "@agentbridge/core"
import type { CommandId, CommandOutcome, ContentBlock, EventId, NoticeKind, SessionId, ToolCallId, ToolKind } from "@agentbridge/schema"
import { Option, Schema } from "effect"
import {
  GooseBlock,
  IGNORED_BLOCK_TYPES,
  KNOWN_BLOCK_TYPES,
  LegacyMessage,
  MessageMetadata,
  type MessageRow,
  type ToolRequestBlock,
  type ToolResponseBlock
} from "./schema/GooseRecord.ts"

export const HARNESS = "goose"
export const NAME = "Goose"
export const FORMAT = "goose-sqlite"
export const LEGACY_FORMAT = "goose-session-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native Goose tool names are interpreted)
// ---------------------------------------------------------------------------

/**
 * Goose prefixes MCP tools with their extension (`developer__shell`). The built-in
 * `developer` extension has been unprefixed since 1.2x (`shell`, `write`, `edit`, `tree`,
 * `read_image`); ACP clients that offer file reads add `read`.
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  read_image: "read",
  write: "edit",
  edit: "edit",
  shell: "execute",
  tree: "search",
  analyze: "search",
  developer__shell: "execute",
  developer__text_editor: "edit",
  developer__image_processor: "read",
  developer__analyze: "search",
  todo__todo_write: "think",
  todo__todo_read: "think",
  computercontroller__web_search: "search",
  computercontroller__web_scrape: "fetch"
}

/** `developer__text_editor` is one tool for viewing and editing; its kind follows `command`. */
export const toolKind = (name: string, input?: unknown): ToolKind => {
  if (name === "developer__text_editor") return stringProp(input, "command") === "view" ? "read" : "edit"
  return TOOL_KINDS[name] ?? "other"
}

const COMMAND_TOOLS = new Set(["shell", "developer__shell"])

// ---------------------------------------------------------------------------
// Input: one stored `Message`, from a database row or a legacy JSONL line
// ---------------------------------------------------------------------------

export type GooseInput =
  | {
    readonly _tag: "Message"
    readonly index: number
    readonly nativeId: string
    readonly role: string
    readonly content: ReadonlyArray<unknown>
    /** Unix seconds (milliseconds in some older rows). */
    readonly created: number | undefined
    readonly metadata: MessageMetadata | undefined
  }
  | { readonly _tag: "Malformed"; readonly index: number; readonly reason: "json" | "schema"; readonly nativeId?: string }
  | { readonly _tag: "Header"; readonly index: number; readonly header: unknown }
  | { readonly _tag: "Skip"; readonly index: number }

const decodeMetadata = Schema.decodeUnknownOption(MessageMetadata)
const decodeLegacyMessage = Schema.decodeUnknownOption(LegacyMessage)

const metadataOf = (value: unknown): MessageMetadata | undefined =>
  value === undefined || value === null ? undefined : Option.getOrUndefined(decodeMetadata(value))

/** A `messages` row. `ordinal` is the row's position in the session. */
export const decodeRow = (row: MessageRow, ordinal: number): GooseInput => {
  const nativeId = row.message_id ?? `row-${row.id}`
  const content = parseJson(row.content_json)
  if (Option.isNone(content)) return { _tag: "Malformed", index: ordinal, reason: "json", nativeId }
  if (!Array.isArray(content.value)) return { _tag: "Malformed", index: ordinal, reason: "schema", nativeId }
  const metadata = row.metadata_json === null ? undefined : Option.getOrUndefined(parseJson(row.metadata_json))
  return {
    _tag: "Message",
    index: ordinal,
    nativeId,
    role: row.role,
    content: content.value,
    created: typeof row.created_timestamp === "number" ? row.created_timestamp : undefined,
    metadata: metadataOf(metadata)
  }
}

/** A line of a legacy JSONL session: line 0 is the session header, the rest are messages. */
export const decodeLegacyLine = ({ index, line }: SourceLine): GooseInput => {
  if (line.trim().length === 0) return { _tag: "Skip", index }
  const json = parseJson(line)
  if (Option.isNone(json)) return { _tag: "Malformed", index, reason: "json" }
  if (index === 0) return { _tag: "Header", index, header: json.value }
  const message = Option.getOrUndefined(decodeLegacyMessage(json.value))
  if (message === undefined) return { _tag: "Malformed", index, reason: "schema" }
  return {
    _tag: "Message",
    index,
    nativeId: message.id ?? `line-${index}`,
    role: message.role,
    content: message.content,
    created: message.created,
    metadata: metadataOf(message.metadata)
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly commandStartedId?: EventId
}

export interface GooseState {
  readonly sessionId: SessionId
  readonly path: string
  readonly format: string
  readonly cwd: string | undefined
  readonly started: boolean
  readonly sawPrompt: boolean
  /** The open turn: the ID of the prompt message that started it. */
  readonly turn: string | undefined
  readonly tools: ReadonlyMap<string, OpenTool>
  /** Calls the model made with an unparseable tool call; their responses are not outcomes. */
  readonly invalidCalls: ReadonlySet<string>
}

export const initialState = (sessionId: SessionId, path: string, format: string, cwd: string | undefined): GooseState => ({
  sessionId,
  path,
  format,
  cwd,
  started: false,
  sawPrompt: false,
  turn: undefined,
  tools: new Map(),
  invalidCalls: new Set()
})

const decodeBlock = makeRecordDecoder({ schema: GooseBlock, known: KNOWN_BLOCK_TYPES, ignored: IGNORED_BLOCK_TYPES })

/** Goose stores seconds; a few older rows hold milliseconds (`MILLISECOND_TIMESTAMP_THRESHOLD`). */
export const messageTime = (created: number | undefined): string | undefined => {
  if (created === undefined || !Number.isFinite(created) || created <= 0) return undefined
  return new Date(created > 10_000_000_000 ? created : created * 1000).toISOString()
}

const asJson = (value: unknown) => value as Schema.Json

/** Delegated tasks start with `Subagent ID: <id>` followed by the task; the task is the prompt. */
const SUBAGENT_PREFIX = /^Subagent ID: \S+\n\n/

const INJECTED_PREFIXES = ["<turn-context>", "<system-reminder>"]

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

interface ToolOutput {
  readonly ok: boolean
  /** Text meant for the model (blocks addressed only to the user are UI duplicates). */
  readonly texts: ReadonlyArray<string>
  readonly structured: unknown
  readonly error: string | undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const contentTexts = (content: unknown): Array<string> => {
  if (!Array.isArray(content)) return []
  const all: Array<{ text: string; userOnly: boolean }> = []
  for (const item of content) {
    const block = record(item)
    if (block === undefined) continue
    const audience = record(block["annotations"])?.["audience"]
    const userOnly = Array.isArray(audience) && audience.length > 0 && !audience.includes("assistant")
    if (block["type"] === "text" && typeof block["text"] === "string") all.push({ text: block["text"], userOnly })
    const resource = record(block["resource"])
    if (block["type"] === "resource" && typeof resource?.["text"] === "string") all.push({ text: resource["text"], userOnly })
  }
  const forModel = all.filter((t) => !t.userOnly)
  return (forModel.length > 0 ? forModel : all).map((t) => t.text)
}

/** `toolResult`: `{status: "success", value: CallToolResult | Content[]}` or `{status: "error", error}`. */
export const toolOutput = (result: ToolResponseBlock["toolResult"]): ToolOutput => {
  if (result.status === "error" || (result.status === undefined && result.error !== undefined)) {
    return { ok: false, texts: [], structured: undefined, error: typeof result.error === "string" ? result.error : "error" }
  }
  const value = result.value
  if (Array.isArray(value)) return { ok: true, texts: contentTexts(value), structured: undefined, error: undefined }
  const call = record(value)
  return {
    ok: call?.["isError"] !== true,
    texts: contentTexts(call?.["content"]),
    structured: call?.["structuredContent"],
    error: undefined
  }
}

/**
 * Exit status of a shell call, only as recorded: the platform `shell` tool's
 * `structuredContent.exit_code` (and its `Command exited with code N` trailer), or the
 * ACP terminal's leading `exit code: N` block. The pre-1.2x `developer__shell` MCP tool
 * ignored the exit status, so its successful results have an unknown outcome.
 */
export const shellStatus = (
  name: string,
  output: ToolOutput
): { readonly outcome: CommandOutcome; readonly exitCode?: number; readonly stdout?: string } => {
  const structured = record(output.structured)
  const text = output.texts.join("\n")
  if (!output.ok && output.error !== undefined) {
    return { outcome: /cancel|interrupt/i.test(output.error) ? "interrupted" : "failed", stdout: output.error }
  }
  const acp = /^exit code: (-?\d+)$/.exec(output.texts[0] ?? "")
  const trailer = /\n*Command exited with code (-?\d+)\s*$/.exec(text)
  const structuredCode = structured?.["exit_code"]
  const exitCode = typeof structuredCode === "number"
    ? structuredCode
    : acp !== null
    ? Number(acp[1])
    : trailer !== null
    ? Number(trailer[1])
    : undefined
  const stdout = acp !== null ? output.texts.slice(1).join("\n") : trailer !== null ? text.slice(0, trailer.index) : text
  const withStdout = stdout.length > 0 ? { stdout } : {}
  if (structured?.["timed_out"] === true || /\n\nCommand timed out after \d+ seconds/.test(text)) {
    return { outcome: "interrupted", ...(exitCode !== undefined ? { exitCode } : {}), ...withStdout }
  }
  if (exitCode !== undefined) return { outcome: exitCode === 0 && output.ok ? "succeeded" : "failed", exitCode, ...withStdout }
  if (!output.ok) return { outcome: "failed", ...withStdout }
  return { outcome: name === "developer__shell" ? "unknown" : "succeeded", ...withStdout }
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [GooseState, ReadonlyArray<Emission>]

export const normalize = (state: GooseState, input: GooseInput): Step => {
  if (input._tag === "Skip") return [state, []]
  const base = { harness: HARNESS, sessionId: state.sessionId, format: state.format, path: state.path, recordIndex: input.index }
  if (input._tag === "Header") return normalizeHeader(state, input.header, new RecordScope(base))
  if (input._tag === "Malformed") {
    const s = new RecordScope({ ...base, nativeEventId: input.nativeId })
    warnUndecodable(s, { _tag: "Malformed", index: input.index, reason: input.reason, nativeType: "message" }, NAME)
    return [state, s.emissions]
  }
  return normalizeMessage(state, input, new RecordScope({ ...base, nativeEventId: input.nativeId, timestamp: messageTime(input.created) }))
}

const normalizeHeader = (state: GooseState, header: unknown, s: RecordScope): Step => {
  const title = stringProp(header, "name", "description")
  const cwd = stringProp(header, "working_dir")
  if (title !== undefined && title.trim().length > 0) s.metadata({ title: { value: title.trim(), priority: 30 } })
  return [cwd !== undefined && cwd.length > 0 ? { ...state, cwd } : state, s.emissions]
}

const normalizeMessage = (initial: GooseState, message: Extract<GooseInput, { _tag: "Message" }>, s: RecordScope): Step => {
  if (message.role !== "user" && message.role !== "assistant") return [initial, []]
  let state = initial
  if (!state.started && s.options.timestamp !== undefined) {
    s.event({ type: "session.started", certainty: "known" })
    state = { ...state, started: true }
  }
  const metadata = message.metadata
  // Goose treats missing metadata as visible to both (pre-1.0 messages have none).
  const forModelOnly = metadata?.userVisible === false

  const blocks: Array<GooseBlock> = []
  for (const raw of message.content) {
    const decoded = decodeBlock(message.index, raw)
    if (decoded._tag === "Skip") continue
    if (decoded._tag !== "Record") warnUndecodable(s, decoded, NAME)
    else blocks.push(decoded.record)
  }

  if (message.role === "user") state = userMessage(state, s, message.nativeId, blocks, metadata, forModelOnly)
  else state = assistantMessage(state, s, blocks, metadata, forModelOnly)
  return [state, s.emissions]
}

const notice = (s: RecordScope, kind: NoticeKind, text: string) => {
  if (text.trim().length > 0) s.event({ type: "harness.notice", certainty: "known", kind, content: [{ type: "text", text }] })
}

/** Notices and markers that may appear in either role. Returns true when handled. */
const sharedBlock = (s: RecordScope, block: GooseBlock): boolean => {
  switch (block.type) {
    case "systemNotification":
      notice(s, block.notificationType === "creditsExhausted" ? "error" : "other", block.msg)
      return true
    case "error":
      notice(s, "error", block.message)
      return true
    case "contextLengthExceeded":
      notice(s, "error", block.msg ?? "Context length exceeded")
      return true
    case "summarizationRequested":
      notice(s, "other", block.msg ?? "Summarization requested")
      return true
    case "conversationCompacted":
      s.event({ type: "context.compacted", certainty: "known" })
      return true
    default:
      return false
  }
}

const userMessage = (
  initial: GooseState,
  s: RecordScope,
  messageId: string,
  blocks: ReadonlyArray<GooseBlock>,
  metadata: MessageMetadata | undefined,
  forModelOnly: boolean
): GooseState => {
  let state = initial
  const prompt: Array<ContentBlock> = []
  for (const block of blocks) {
    if (sharedBlock(s, block)) continue
    switch (block.type) {
      case "toolResponse":
        state = completeTool(state, s, block, forModelOnly)
        break
      case "text": {
        if (block.text.trim().length === 0) break
        // Turn context, compaction summaries and the re-sent prompt after compaction are
        // agent-only copies Goose wrote for the model.
        if (forModelOnly || metadata?.turnContext === true || INJECTED_PREFIXES.some((p) => block.text.trimStart().startsWith(p))) {
          notice(s, "injected_context", block.text)
        } else {
          prompt.push({ type: "text", text: prompt.length === 0 ? block.text.replace(SUBAGENT_PREFIX, "") : block.text })
        }
        break
      }
      default:
        break
    }
  }
  if (prompt.length === 0) return state
  // A steer joins the running turn rather than starting one.
  if (metadata?.steer !== true || state.turn === undefined) state = { ...state, turn: startTurn(s, state.turn, messageId) }
  s.event({ type: "user.message", certainty: "known", content: prompt })
  if (!state.sawPrompt) {
    const text = prompt.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
    s.metadata({ title: { value: titleFrom(text), priority: 10 } })
    state = { ...state, sawPrompt: true }
  }
  return state
}

const assistantMessage = (
  initial: GooseState,
  s: RecordScope,
  blocks: ReadonlyArray<GooseBlock>,
  metadata: MessageMetadata | undefined,
  forModelOnly: boolean
): GooseState => {
  let state = initial
  let replied = false
  let calledTools = false
  let failed = false
  const text: Array<ContentBlock> = []
  const flushText = () => {
    if (text.length === 0) return
    // Agent-only assistant text is Goose's own continuation prompt after compaction.
    if (forModelOnly) s.event({ type: "harness.notice", certainty: "known", kind: "injected_context", content: text.splice(0) })
    else {
      s.event({ type: "agent.message", certainty: "known", content: text.splice(0) })
      replied = true
    }
  }
  for (const block of blocks) {
    if (block.type !== "text") flushText()
    if (sharedBlock(s, block)) {
      if (block.type === "error" || block.type === "contextLengthExceeded") failed = true
      continue
    }
    switch (block.type) {
      case "text":
        if (block.text.length > 0) text.push({ type: "text", text: block.text })
        break
      case "thinking":
      case "reasoning": {
        // Redacted or summarized-away reasoning is empty; never reconstruct it.
        const content = block.type === "thinking" ? block.thinking : block.text
        if (content.trim().length > 0) {
          s.event({ type: "agent.reasoning", certainty: "known", content, representation: "provider_exposed" })
        }
        break
      }
      case "toolRequest":
      case "frontendToolRequest":
        state = startTool(state, s, block)
        calledTools = true
        break
      default:
        break
    }
  }
  flushText()

  const model = metadata?.inference?.resolvedModel ?? metadata?.inference?.requestedModel
  if (model !== undefined && model !== null) s.metadata({ metadata: { model } })
  const usage = metadata?.usage
  if (usage !== undefined && usage !== null) {
    const input = tokenCount(usage.inputTokens ?? undefined)
    const cacheRead = tokenCount(usage.cacheReadTokens ?? undefined)
    const cacheWrite = tokenCount(usage.cacheWriteTokens ?? undefined)
    // Goose's input counts every prompt token; the canonical input excludes cache reads and writes.
    const uncached = input === undefined ? undefined : input - (cacheRead ?? 0) - (cacheWrite ?? 0)
    const fields = usageFields({
      model: model ?? undefined,
      inputTokens: uncached !== undefined && uncached >= 0 ? uncached : undefined,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      // Providers report reasoning inside output; Goose keeps no separate count.
      outputTokens: tokenCount(usage.outputTokens ?? undefined)
    })
    if (Object.keys(fields).some((key) => key !== "model")) s.event({ type: "usage.recorded", certainty: "known", ...fields })
  }

  // Goose records no turn boundary. A reply without tool calls is where its loop stops.
  if (!calledTools && (replied || failed) && state.tools.size === 0) {
    state = { ...state, turn: endTurn(s, state.turn, failed ? "failed" : "completed", { certainty: "inferred" }) }
  }
  return state
}

/** `toolCall.value` is MCP `CallToolRequestParams`: `{name, arguments}`. */
const callOf = (block: ToolRequestBlock): { readonly name: string; readonly input: unknown } | undefined => {
  const value = record(block.toolCall.value)
  const name = value?.["name"]
  if (block.toolCall.status === "error" || typeof name !== "string") return undefined
  return { name, input: value?.["arguments"] ?? undefined }
}

const startTool = (state: GooseState, s: RecordScope, block: ToolRequestBlock): GooseState => {
  const call = callOf(block)
  if (call === undefined) {
    // The model emitted a call Goose could not parse; Goose answers it with an error.
    const error = block.toolCall.error
    notice(s, "error", typeof error === "string" ? error : "Invalid tool call")
    return { ...state, invalidCalls: new Set([...state.invalidCalls, block.id]) }
  }
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: block.id as ToolCallId,
    name: call.name,
    kind: toolKind(call.name, call.input),
    ...(call.input !== undefined ? { input: asJson(call.input) } : {})
  })
  const command = COMMAND_TOOLS.has(call.name) ? stringProp(call.input, "command") : undefined
  const commandStartedId = command === undefined ? undefined : s.event({
    type: "command.started",
    certainty: "known",
    commandId: block.id as CommandId,
    command,
    ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
    parentEventId: startedId,
    derivedFrom: [startedId]
  })
  const tools = new Map(state.tools)
  tools.set(block.id, {
    startedId,
    name: call.name,
    input: call.input,
    ...(commandStartedId !== undefined ? { commandStartedId } : {})
  })
  return { ...state, tools }
}

const completeTool = (state: GooseState, s: RecordScope, block: ToolResponseBlock, forModelOnly: boolean): GooseState => {
  if (state.invalidCalls.has(block.id)) return state
  const open = state.tools.get(block.id)
  if (open === undefined) {
    // Agent-only copies (compaction) may answer calls that are no longer in the history.
    if (!forModelOnly) s.warning("orphan_tool_result", "Tool results without a matching tool call")
    return state
  }
  const output = toolOutput(block.toolResult)
  const text = output.texts.join("\n")
  const toolCallId = block.id as ToolCallId
  const resultId = output.ok
    ? s.event({ type: "tool.completed", certainty: "known", toolCallId, ...(text.length > 0 ? { output: text } : {}) })
    : s.event({ type: "tool.failed", certainty: "known", toolCallId, message: output.error ?? (text.length > 0 ? text : "error") })
  const tools = new Map(state.tools)
  tools.delete(block.id)
  const derivedFrom = [open.startedId, resultId]

  if (open.commandStartedId !== undefined) {
    const status = shellStatus(open.name, output)
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: block.id as CommandId,
      outcome: status.outcome,
      ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      ...(status.stdout !== undefined ? { stdout: status.stdout } : {}),
      parentEventId: open.startedId,
      derivedFrom
    })
  }
  if (output.ok) fileEffects(s, open, text, state.cwd, derivedFrom)
  return { ...state, tools }
}

const absolute = (path: string, cwd: string | undefined) =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || cwd === undefined ? path : `${cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`

/** Files named by `+++ b/<path>` headers of a unified diff. */
const diffPaths = (diff: string, cwd: string | undefined) =>
  [...diff.matchAll(/^\+\+\+ (?:b\/)?(.+?)\s*$/gm)].map((m) => m[1]!).filter((p) => p !== "/dev/null").map((p) => absolute(p, cwd))

const fileEffects = (s: RecordScope, tool: OpenTool, resultText: string, cwd: string | undefined, derivedFrom: Array<EventId>) => {
  const link = { certainty: "known" as const, parentEventId: tool.startedId, derivedFrom }
  const raw = stringProp(tool.input, "path")
  const path = raw === undefined ? undefined : absolute(raw, cwd)
  switch (tool.name) {
    case "read":
    case "read_image":
    case "developer__image_processor":
      if (path !== undefined) s.event({ type: "file.read", path, ...link })
      return
    case "edit":
      if (path !== undefined) s.event({ type: "file.changed", path, ...link })
      return
    case "write":
      // `Created <path> (n lines)` for a new file, `Wrote <path> (n lines)` for an overwrite.
      if (path === undefined) return
      if (resultText.startsWith("Created ")) s.event({ type: "file.created", path, ...link })
      else if (resultText.startsWith("Wrote ")) s.event({ type: "file.changed", path, ...link })
      else s.event({ type: "file.changed", path, ...link, certainty: "inferred" })
      return
    case "developer__text_editor": {
      const command = stringProp(tool.input, "command")
      if (command === "view") {
        // Viewing a directory lists it; that is not a file read.
        if (path !== undefined && !/^'.*' is a directory\./.test(resultText)) s.event({ type: "file.read", path, ...link })
        return
      }
      const diff = stringProp(tool.input, "diff")
      if (command === "str_replace" && diff !== undefined) {
        for (const changed of diffPaths(diff, cwd)) s.event({ type: "file.changed", path: changed, ...link })
        return
      }
      if (path === undefined) return
      // The MCP `write` command reports "Successfully wrote to <path>" for new and existing files alike.
      if (command === "write") s.event({ type: "file.changed", path, ...link, certainty: "inferred" })
      else if (command === "str_replace" || command === "insert" || command === "undo_edit") {
        s.event({ type: "file.changed", path, ...link })
      }
      return
    }
  }
}
