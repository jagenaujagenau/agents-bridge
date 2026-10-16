import {
  type Emission,
  emitPlan,
  endTurn,
  makeRecordDecoder,
  parseJson,
  planList,
  RecordScope,
  startTurn,
  stringProp,
  titleFrom,
  warnUndecodable
} from "@agentbridge/core"
import type { CommandId, CommandOutcome, ContentBlock, EventId, NoticeKind, SessionId, ToolCallId, ToolKind } from "@agentbridge/schema"
import { Option, type Schema } from "effect"
import {
  CrushPart,
  IGNORED_PART_TYPES,
  KNOWN_PART_TYPES,
  type MessageRow,
  type ToolCallPart,
  type ToolResultPart
} from "./schema/CrushRecord.ts"

export const HARNESS = "crush"
export const NAME = "Crush"
export const FORMAT = "crush-sqlite"

/** Crush's built-in tools (internal/agent/tools, internal/agent/agent_tool.go). MCP tools fall back to `other`. */
const TOOL_KINDS: Record<string, ToolKind> = {
  view: "read",
  read_mcp_resource: "read",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  lsp_rename: "edit",
  lsp_replace_symbol: "edit",
  bash: "execute",
  job_output: "execute",
  job_kill: "execute",
  ls: "search",
  glob: "search",
  grep: "search",
  sourcegraph: "search",
  web_search: "search",
  list_mcp_resources: "search",
  lsp_definition: "search",
  lsp_references: "search",
  lsp_symbols: "search",
  lsp_call_hierarchy: "search",
  lsp_diagnostics: "search",
  fetch: "fetch",
  web_fetch: "fetch",
  agentic_fetch: "fetch",
  download: "fetch",
  todos: "think"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

/** A tool call waiting for its `tool_result`, which arrives in a later `tool`-role message. */
interface OpenTool {
  readonly name: string
  readonly input: unknown
  readonly startedId: EventId
  readonly commandStarted: boolean
}

export interface CrushState {
  readonly sessionId: SessionId
  readonly database: string
  readonly cwd: string | undefined
  readonly started: boolean
  readonly sawPrompt: boolean
  /** The open turn (one Crush agent run), if any. */
  readonly turn: string | undefined
  readonly tools: Readonly<Record<string, OpenTool>>
}

export const initialState = (sessionId: SessionId, database: string, cwd: string | undefined): CrushState => ({
  sessionId,
  database,
  cwd,
  started: false,
  sawPrompt: false,
  turn: undefined,
  tools: {}
})

const decodePart = makeRecordDecoder({ schema: CrushPart, known: KNOWN_PART_TYPES, ignored: IGNORED_PART_TYPES })

/** Crush stores Unix seconds; 0 means "not recorded". */
const iso = (seconds: number | null | undefined) =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined

const isoMillis = (millis: unknown) =>
  typeof millis === "number" && Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : undefined

const asJson = (value: unknown) => value as Schema.Json

/** Parse a JSON-encoded string field (tool input, result metadata); undefined when absent or invalid. */
const jsonField = (text: string | undefined): unknown =>
  text === undefined || text.trim().length === 0 ? undefined : Option.getOrUndefined(parseJson(text))

const numberProp = (value: unknown, key: string): number | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === "number" && Number.isFinite(found) ? found : undefined
}

/**
 * The bash tool's result text (`formatOutput` in internal/agent/tools/bash.go): a non-zero
 * exit appends `Exit code N`, an interrupt appends `Command was aborted before completion`,
 * and the output ends with `<cwd>…</cwd>`. A successful exit adds no trailer, so success
 * carries no exit code.
 */
const EXIT_TRAILER = /(?:^|\n)Exit code (\d+)(?:\n\n<cwd>[^\n]*<\/cwd>)?\s*$/
const ABORTED_TRAILER = /(?:^|\n)Command was aborted before completion(?:\n\n<cwd>[^\n]*<\/cwd>)?\s*$/

export const bashStatus = (
  content: string,
  isError: boolean,
  background: boolean
): { readonly outcome: CommandOutcome; readonly exitCode?: number } => {
  if (isError) return { outcome: /cancel|abort|interrupt/i.test(content) ? "interrupted" : "failed" }
  if (ABORTED_TRAILER.test(content)) return { outcome: "interrupted" }
  const exit = EXIT_TRAILER.exec(content)
  if (exit !== null) {
    const exitCode = Number(exit[1])
    return { outcome: exitCode === 0 ? "succeeded" : "failed", exitCode }
  }
  // A job moved to the background has not finished when the result is written.
  if (background) return { outcome: "unknown" }
  return { outcome: "succeeded" }
}

type Step = readonly [CrushState, ReadonlyArray<Emission>]

/** Normalize one `messages` row. `ordinal` is the row's position in the session. */
export const normalizeMessage = (initial: CrushState, [row, ordinal]: readonly [MessageRow, number]): Step => {
  let state = initial
  const created = iso(row.created_at)
  const scopeFor = (nativeEventId: string, timestamp: string | undefined = created) =>
    new RecordScope({
      harness: HARNESS,
      sessionId: state.sessionId,
      format: FORMAT,
      path: state.database,
      recordIndex: ordinal,
      nativeEventId,
      timestamp
    })

  const head = scopeFor(row.id)
  const json = parseJson(row.parts)
  if (Option.isNone(json)) {
    head.warning("malformed_json", "Skipped messages whose parts are not valid JSON")
    return [state, head.emissions]
  }
  if (!Array.isArray(json.value)) {
    head.warning("malformed_record", "Skipped messages whose parts are not a list")
    return [state, head.emissions]
  }
  if (row.role !== "user" && row.role !== "assistant" && row.role !== "tool") {
    head.warning("unknown_record_type", `Ignored unknown ${NAME} message role "${row.role}"`)
    return [state, head.emissions]
  }

  if (!state.started) {
    head.event({ type: "session.started", certainty: "known" })
    state = { ...state, started: true }
  }
  if (row.role === "assistant" && row.model) {
    head.metadata({ metadata: { model: row.model, ...(row.provider ? { provider: row.provider } : {}) } })
  }

  const parts: Array<{ readonly part: CrushPart; readonly scope: RecordScope }> = []
  const emissions: Array<Emission> = []
  json.value.forEach((raw, index) => {
    const s = scopeFor(`${row.id}#${index}`)
    const decoded = decodePart(ordinal, raw)
    if (decoded._tag === "Record") parts.push({ part: decoded.record, scope: s })
    else if (decoded._tag !== "Skip") {
      warnUndecodable(s, decoded, NAME)
      emissions.push(...s.emissions)
    }
  })

  switch (row.role) {
    case "user":
      return user(state, row, head, parts, emissions)
    case "assistant":
      return assistant(state, row, head, parts, emissions)
    case "tool":
      return tool(state, head, parts, emissions)
  }
}

type Parts = ReadonlyArray<{ readonly part: CrushPart; readonly scope: RecordScope }>

const user = (state: CrushState, row: MessageRow, head: RecordScope, parts: Parts, warnings: ReadonlyArray<Emission>): Step => {
  const prompt: Array<ContentBlock> = []
  const notices: Array<{ kind: NoticeKind; text: string }> = []
  const after: Array<Emission> = []
  for (const { part, scope } of parts) {
    switch (part.type) {
      case "text":
        if (part.data.text.trim().length === 0) break
        // A generated continuation (plan mode's "Implement the plan."): it starts a run but
        // was not written by the user.
        if (part.data.hidden === true) notices.push({ kind: "injected_context", text: part.data.text })
        else prompt.push({ type: "text", text: part.data.text })
        break
      case "binary":
        if (part.data.Path) prompt.push({ type: "file", path: part.data.Path })
        break
      case "image_url":
        if (!part.data.url.startsWith("data:")) prompt.push({ type: "image", uri: part.data.url })
        break
      case "shell_command":
        userCommand(state, scope, part.data)
        after.push(...scope.emissions)
        break
      default:
        // `finish` (a synthetic `stop`) and parts that never occur on user messages.
        break
    }
  }

  let next = state
  const s = messageScope(head)
  if (prompt.length > 0 || notices.length > 0) {
    // Every agent run begins with exactly one user message, visible or not.
    next = { ...next, turn: startTurn(s, next.turn, row.id) }
  }
  for (const notice of notices) {
    s.event({ type: "harness.notice", certainty: "known", kind: notice.kind, content: [{ type: "text", text: notice.text }] })
  }
  if (prompt.length > 0) {
    s.event({ type: "user.message", certainty: "known", content: prompt })
    const first = prompt.find((b) => b.type === "text")
    if (!next.sawPrompt && first?.type === "text") {
      s.metadata({ title: { value: titleFrom(first.text), priority: 10 } })
      next = { ...next, sawPrompt: true }
    }
  }
  return [next, [...head.emissions, ...s.emissions, ...after, ...warnings]]
}

/** A second scope anchored on the message, for events that follow its parts' or `head`'s. */
const messageScope = (head: RecordScope, timestamp?: string) =>
  new RecordScope({ ...head.options, nativeEventId: `${head.options.nativeEventId}#message`, ...(timestamp !== undefined ? { timestamp } : {}) })

const userCommand = (
  state: CrushState,
  s: RecordScope,
  command: { readonly command: string; readonly output?: string; readonly exit_code?: number }
) => {
  const commandId = (s.options.nativeEventId ?? `record-${s.options.recordIndex}`) as CommandId
  const startedId = s.event({
    type: "command.started",
    certainty: "known",
    commandId,
    command: command.command,
    ...(state.cwd !== undefined ? { cwd: state.cwd } : {})
  })
  const exitCode = typeof command.exit_code === "number" && Number.isInteger(command.exit_code) ? command.exit_code : undefined
  s.event({
    type: "command.completed",
    certainty: "known",
    commandId,
    outcome: exitCode === undefined ? "unknown" : exitCode === 0 ? "succeeded" : "failed",
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(command.output !== undefined && command.output.length > 0 ? { stdout: command.output } : {}),
    parentEventId: startedId,
    derivedFrom: [startedId]
  })
}

const assistant = (state: CrushState, row: MessageRow, head: RecordScope, parts: Parts, warnings: ReadonlyArray<Emission>): Step => {
  let next = state
  const emissions: Array<Emission> = []

  // A compaction summary (`is_summary_message`): later model calls see only this text.
  if (row.is_summary_message === 1) {
    const summary = parts.flatMap(({ part }) => (part.type === "text" ? [part.data.text] : [])).join("\n")
    const s = messageScope(head)
    s.event({ type: "context.compacted", certainty: "known", ...(summary.trim().length > 0 ? { summary } : {}) })
    return [next, [...head.emissions, ...s.emissions, ...warnings]]
  }

  for (const { part, scope } of parts) {
    switch (part.type) {
      case "reasoning":
        if (part.data.thinking.trim().length > 0) {
          const at = iso(part.data.started_at)
          scope.event({
            type: "agent.reasoning",
            certainty: "known",
            content: part.data.thinking,
            representation: "provider_exposed",
            ...(at !== undefined ? { timestamp: at } : {})
          })
        }
        break
      case "text":
        if (part.data.text.trim().length > 0) {
          scope.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: part.data.text }] })
        }
        break
      case "tool_call":
        next = startTool(next, scope, part)
        break
      case "finish": {
        const { reason, message, details } = part.data
        if (reason === "tool_use") break
        // The finish's own time, when recorded, dates the end of the model call.
        const at = iso(part.data.time)
        const s = at === undefined ? scope : new RecordScope({ ...scope.options, timestamp: at })
        if (reason === "canceled" || reason === "error" || reason === "content_filter") {
          const text = [message, details].filter((t): t is string => t !== undefined && t.length > 0).join(": ")
          s.event({
            type: "harness.notice",
            certainty: "known",
            kind: reason === "canceled" ? "interruption" : "error",
            content: [{ type: "text", text: text.length > 0 ? text : reason === "content_filter" ? "Refused by the provider" : reason }]
          })
        }
        next = { ...next, turn: endTurn(s, next.turn, finishOutcome(reason)) }
        if (s !== scope) emissions.push(...s.emissions)
        break
      }
      default:
        break
    }
    emissions.push(...scope.emissions)
  }
  return [next, [...head.emissions, ...emissions, ...warnings]]
}

const finishOutcome = (reason: string) => {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
      return "completed"
    case "canceled":
      return "interrupted"
    case "error":
    case "content_filter":
      return "failed"
    default:
      return "unknown"
  }
}

const startTool = (state: CrushState, s: RecordScope, part: ToolCallPart): CrushState => {
  const { id, name } = part.data
  const input = jsonField(part.data.input)
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: id as ToolCallId,
    name,
    kind: toolKind(name),
    ...(input !== undefined ? { input: asJson(input) } : {})
  })
  const command = name === "bash" ? stringProp(input, "command") : undefined
  if (command !== undefined) {
    const cwd = stringProp(input, "working_dir") ?? state.cwd
    s.event({
      type: "command.started",
      certainty: "known",
      commandId: id as CommandId,
      command,
      ...(cwd ? { cwd } : {}),
      parentEventId: startedId,
      derivedFrom: [startedId]
    })
  }
  return { ...state, tools: { ...state.tools, [id]: { name, input, startedId, commandStarted: command !== undefined } } }
}

const tool = (state: CrushState, head: RecordScope, parts: Parts, warnings: ReadonlyArray<Emission>): Step => {
  let tools = state.tools
  const emissions: Array<Emission> = []
  for (const { part, scope } of parts) {
    if (part.type !== "tool_result") continue
    const open = tools[part.data.tool_call_id]
    if (open === undefined) {
      scope.warning("orphan_tool_result", "Skipped tool results without a matching tool call")
    } else {
      finishTool(scope, part, open)
      const { [part.data.tool_call_id]: _, ...rest } = tools
      tools = rest
    }
    emissions.push(...scope.emissions)
  }
  return [{ ...state, tools }, [...head.emissions, ...emissions, ...warnings]]
}

const finishTool = (s: RecordScope, part: ToolResultPart, open: OpenTool) => {
  const toolCallId = part.data.tool_call_id as ToolCallId
  const content = part.data.content ?? ""
  const failed = part.data.is_error === true
  const metadata = jsonField(part.data.metadata)
  const startMs = numberProp(metadata, "start_time")
  const endMs = numberProp(metadata, "end_time")
  const durationMs = startMs !== undefined && endMs !== undefined && endMs >= startMs ? endMs - startMs : undefined
  const ended = isoMillis(endMs)
  const at = {
    ...(ended !== undefined ? { timestamp: ended } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
  const resultId: EventId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: content.length > 0 ? content : "error", ...at })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId, ...(content.length > 0 ? { output: content } : {}), ...at })
  const link = { parentEventId: open.startedId, derivedFrom: [open.startedId, resultId], ...at }

  if (open.commandStarted) {
    const background = metadata !== undefined && (metadata as Record<string, unknown>)["background"] === true
    const status = bashStatus(content, failed, background)
    const stdout = stringProp(metadata, "output") ?? (content.length > 0 ? content : undefined)
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: part.data.tool_call_id as CommandId,
      outcome: status.outcome,
      ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      ...(stdout !== undefined && stdout.length > 0 ? { stdout } : {}),
      ...link
    })
  }

  if (failed) return
  if (open.name === "todos") {
    emitPlan(s, planList(open.input, "todos"), "content", { certainty: "known", ...link })
    return
  }
  const path = stringProp(open.input, "file_path")
  switch (open.name) {
    case "view": {
      const read = stringProp(metadata, "file_path") ?? path
      if (read !== undefined) s.event({ type: "file.read", certainty: "known", path: read, ...link })
      break
    }
    case "edit":
    case "multiedit":
      if (path === undefined) break
      // An edit with an empty `old_string` creates the file and says so.
      if (/^File created\b/.test(content)) s.event({ type: "file.created", certainty: "known", path, ...link })
      else s.event({ type: "file.changed", certainty: "known", path, ...link })
      break
    case "write": {
      if (path === undefined) break
      const diff = stringProp(metadata, "diff")
      // The result text is the same either way; a diff from empty content means the file was new
      // (or empty), so creation is inferred.
      if (diff !== undefined && /^@@ -0,0 \+/m.test(diff)) {
        s.event({ type: "file.created", certainty: "inferred", path, diff, ...link })
      } else {
        s.event({ type: "file.changed", certainty: "known", path, ...(diff ? { diff } : {}), ...link })
      }
      break
    }
  }
}
