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
  warnUndecodable
} from "@agentbridge/core"
import type { CommandId, EventId, SessionId, ToolCallId, ToolKind } from "@agentbridge/schema"
import { Option, Schema } from "effect"
import { CursorBlock, CursorRecord, cursorRecordType, KNOWN_TYPES } from "./schema/CursorRecord.ts"

export const HARNESS = "cursor"
export const NAME = "Cursor"
export const FORMAT = "cursor-agent-transcript-jsonl"

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  ReadFile: "read",
  Write: "edit",
  StrReplace: "edit",
  ApplyPatch: "edit",
  EditNotebook: "edit",
  Delete: "delete",
  Shell: "execute",
  AwaitShell: "execute",
  Grep: "search",
  rg: "search",
  Glob: "search",
  SemanticSearch: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  TodoWrite: "think",
  CreatePlan: "think",
  UpdateCurrentStep: "think",
  updateCurrentStep: "think"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

export const decodeLine = makeLineDecoder({
  schema: CursorRecord,
  typeOf: cursorRecordType,
  known: KNOWN_TYPES,
  ignored: new Set()
})

const decodeBlock = Schema.decodeUnknownOption(CursorBlock)

// ---------------------------------------------------------------------------
// User text
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
}

/** `Saturday, June 14, 2026, 3:42 PM (UTC+2)` → `2026-06-14T13:42:00.000Z` */
export const parseCursorTimestamp = (text: string): string | undefined => {
  const m = /([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC([+-]\d{1,2})(?::?(\d{2}))?\)/.exec(text)
  if (!m) return undefined
  const month = MONTHS[m[1]!]
  if (month === undefined) return undefined
  const hour12 = Number(m[4]) % 12
  const hour = m[6] === "PM" ? hour12 + 12 : hour12
  const offsetMinutes = Number(m[7]) * 60 + Math.sign(Number(m[7]) || 1) * Number(m[8] ?? 0)
  const utc = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offsetMinutes * 60_000
  return new Date(utc).toISOString()
}

export interface CursorUserText {
  readonly prompt: string | undefined
  readonly timestamp: string | undefined
  /** Context sections the client attached around the prompt. */
  readonly context: ReadonlyArray<string>
}

/** Split Cursor's tagged user turn: `<timestamp>`, `<user_query>`, and attached context sections. */
export const splitUserText = (text: string): CursorUserText => {
  const timestampTag = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(text)
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)
  const context = [...text.matchAll(/<([a-z_]+)>[\s\S]*?<\/\1>/g)]
    .filter((match) => match[1] !== "timestamp" && match[1] !== "user_query")
    .map((match) => match[0])
  const untagged = text.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/g, "").trim()
  const prompt = query?.[1]?.trim() ?? (untagged.length > 0 ? untagged : undefined)
  return {
    prompt,
    timestamp: timestampTag ? parseCursorTimestamp(timestampTag[1]!) : undefined,
    context
  }
}

/** File headers of an ApplyPatch body. */
const patchHeaders = (patch: string) =>
  [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((match) => ({
    change: match[1] === "Add" ? "created" as const : match[1] === "Delete" ? "deleted" as const : "changed" as const,
    path: match[2]!.trim()
  }))

const asJson = (value: unknown) => value as Schema.Json

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export interface CursorState {
  readonly sessionId: SessionId
  readonly path: string
  readonly started: boolean
  readonly sawPrompt: boolean
  /** The open turn, if any. */
  readonly turn: string | undefined
  readonly projectPath: string | undefined
  /** The latest `<timestamp>` seen; Cursor records time only on user turns. */
  readonly lastTimestamp: string | undefined
  readonly todos: ReadonlyMap<string, CursorTodo>
}

export const initialState = (sessionId: SessionId, path: string, projectPath: string | undefined): CursorState => ({
  sessionId,
  path,
  started: false,
  sawPrompt: false,
  turn: undefined,
  projectPath,
  lastTimestamp: undefined,
  todos: new Map()
})

type Step = readonly [CursorState, ReadonlyArray<Emission>]

export const normalizeLine = (initial: CursorState, line: DecodedRecord<CursorRecord>): Step => {
  let state = initial
  if (line._tag === "Skip") return [state, []]
  const base = { harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.path, recordIndex: line.index }
  if (line._tag !== "Record") {
    const s = new RecordScope(base)
    warnUndecodable(s, line, NAME)
    return [state, s.emissions]
  }
  const record = line.record

  if ("type" in record) {
    const s = new RecordScope(base)
    if (record.status !== undefined && record.status !== "success") {
      const detail = typeof record.error === "string" ? record.error : record.error !== undefined ? JSON.stringify(record.error) : record.status
      s.event({ type: "harness.notice", certainty: "known", kind: "error", content: [{ type: "text", text: detail }] })
    }
    state = { ...state, turn: endTurn(s, state.turn, record.status === "success" ? "completed" : record.status === undefined ? "unknown" : "failed") }
    return [state, s.emissions]
  }

  const blocks = typeof record.message.content === "string"
    ? [{ type: "text" as const, text: record.message.content }]
    : record.message.content.flatMap((raw) => Option.toArray(decodeBlock(raw)))

  if (record.role === "user") {
    const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
    const split = splitUserText(text)
    if (split.timestamp !== undefined) state = { ...state, lastTimestamp: split.timestamp }
    const s = new RecordScope({ ...base, timestamp: split.timestamp })
    if (!state.started) {
      s.event({ type: "session.started", certainty: "known" })
      state = { ...state, started: true }
    }
    if (split.context.length > 0) {
      s.event({
        type: "harness.notice",
        certainty: "known",
        kind: "injected_context",
        content: split.context.map((section) => ({ type: "text" as const, text: section }))
      })
    }
    if (split.prompt !== undefined) {
      state = { ...state, turn: startTurn(s, state.turn, String(line.index)) }
      s.event({ type: "user.message", certainty: "known", content: [{ type: "text", text: split.prompt }] })
      if (!state.sawPrompt) {
        s.metadata({ title: { value: titleFrom(split.prompt), priority: 10 } })
        state = { ...state, sawPrompt: true }
      }
    }
    return [state, s.emissions]
  }

  const s = new RecordScope(base)
  if (!state.started) {
    s.event({ type: "session.started", certainty: "known" })
    state = { ...state, started: true }
  }
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: block.text }] })
      }
      continue
    }
    state = normalizeToolUse(state, s, block)
  }
  return [state, s.emissions]
}

const CursorTodo = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  content: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Schema.String)
})
type CursorTodo = typeof CursorTodo.Type
const decodeTodos = Schema.decodeUnknownOption(Schema.Array(CursorTodo))

const normalizeToolUse = (initial: CursorState, s: RecordScope, block: Extract<CursorBlock, { type: "tool_use" }>): CursorState => {
  let state = initial
  // Cursor records no call IDs; the tool call is identified by its own stable event ID.
  const toolCallId = s.nextId("tool.started") as string as ToolCallId
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId,
    name: block.name,
    kind: toolKind(block.name),
    ...(block.input !== undefined ? { input: asJson(block.input) } : {})
  })
  // Results are not recorded, so every effect below is what the call asked for, not what happened.
  const inferred = { certainty: "inferred" as const, parentEventId: startedId, derivedFrom: [startedId] as Array<EventId> }
  const path = stringProp(block.input, "path", "file_path", "target_file")

  switch (block.name) {
    case "TodoWrite": {
      const updates = Option.getOrUndefined(decodeTodos(planList(block.input, "todos")))
      if (updates === undefined) {
        s.warning("malformed_record", "Skipped malformed plan updates")
        break
      }
      const merge = typeof block.input === "object" && block.input !== null && "merge" in block.input && block.input.merge === true
      const todos = new Map(merge ? state.todos : [])
      for (const todo of updates) {
        const id = String(todo.id)
        if (todo.status === "cancelled") todos.delete(id)
        else todos.set(id, { ...todos.get(id), ...todo, id })
      }
      if (emitPlan(s, [...todos.values()], "content", inferred)) state = { ...state, todos }
      break
    }
    case "Shell": {
      const command = stringProp(block.input, "command")
      const cwd = stringProp(block.input, "working_directory")
      if (cwd !== undefined && state.projectPath === undefined) {
        s.metadata({ projectPath: cwd })
        state = { ...state, projectPath: cwd }
      }
      if (command !== undefined) {
        s.event({
          type: "command.started",
          certainty: "known",
          commandId: toolCallId as string as CommandId,
          command,
          ...(cwd !== undefined ? { cwd } : {}),
          parentEventId: startedId,
          derivedFrom: [startedId]
        })
      }
      break
    }
    case "Read":
    case "ReadFile":
      if (path !== undefined) s.event({ type: "file.read", path, ...inferred })
      break
    case "Write":
    case "StrReplace":
    case "EditNotebook":
      if (path !== undefined) s.event({ type: "file.changed", path, ...inferred })
      break
    case "Delete":
      if (path !== undefined) s.event({ type: "file.deleted", path, ...inferred })
      break
    case "ApplyPatch": {
      const patch = typeof block.input === "string" ? block.input : stringProp(block.input, "patch", "input")
      for (const header of patchHeaders(patch ?? "")) {
        if (header.change === "created") s.event({ type: "file.created", path: header.path, ...inferred })
        else if (header.change === "deleted") s.event({ type: "file.deleted", path: header.path, ...inferred })
        else s.event({ type: "file.changed", path: header.path, ...inferred })
      }
      break
    }
  }
  return state
}
