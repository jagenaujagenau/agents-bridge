import {
  type DecodedRecord,
  type Emission,
  endTurn,
  makeLineDecoder,
  RecordScope,
  startTurn,
  stringProp,
  textOf,
  titleFrom,
  tokenCount,
  usageFields,
  warnUndecodable
} from "@agentbridge/core"
import {
  type CommandId,
  type CommandOutcome,
  type ContentBlock,
  type EventId,
  makeSessionId,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import { Option, Schema } from "effect"
import { KNOWN_TYPES, METADATA_TYPES, PiBlock, type PiMessage, PiRecord } from "./schema/PiRecord.ts"

export const HARNESS = "pi"
export const NAME = "pi"
export const FORMAT = "pi-session-jsonl"

// ---------------------------------------------------------------------------
// Dialects: what differs between pi and formats derived from it
// ---------------------------------------------------------------------------

/** A tool call waiting for its result. */
export interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly commandStartedId?: EventId
}

/** What a tool result message says, before interpretation. */
export interface ToolResultFacts {
  readonly text: string
  readonly failed: boolean
  /** Tool-specific result metadata, as recorded. */
  readonly details: unknown
}

export interface CommandStatus {
  readonly outcome: CommandOutcome
  readonly exitCode?: number
}

/** Links for events derived from a tool result. */
export interface ToolLink {
  readonly parentEventId: EventId
  readonly derivedFrom: ReadonlyArray<EventId>
}

/**
 * The parts of the normalizer that depend on the harness: identity and the tool table.
 * pi's own dialect is `piDialect`; formats derived from pi (oh-my-pi) supply theirs.
 */
export interface PiDialect {
  readonly harness: string
  readonly name: string
  readonly format: string
  readonly toolKind: (name: string) => ToolKind
  /** The shell command a tool call runs, if it is a shell tool. */
  readonly shellCommand: (name: string, input: unknown) => string | undefined
  /** Outcome of a shell tool call, or `undefined` when the result does not end the command. */
  readonly commandStatus: (result: ToolResultFacts) => CommandStatus | undefined
  /** File, plan and other effects a tool result proves. */
  readonly toolEffects: (s: RecordScope, tool: OpenTool, result: ToolResultFacts, link: ToolLink) => void
}

// ---------------------------------------------------------------------------
// Tool vocabulary
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
  powershell: "execute",
  grep: "search",
  find: "search",
  ls: "search"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"])

const piToolEffects = (s: RecordScope, tool: OpenTool, result: ToolResultFacts, link: ToolLink): void => {
  const path = stringProp(tool.input, "path", "file_path")
  if (result.failed || path === undefined) return
  if (tool.name === "read") s.event({ type: "file.read", certainty: "known", path, ...link })
  if (tool.name === "write") s.event({ type: "file.changed", certainty: "known", path, ...link })
  if (tool.name === "edit") {
    // pi 1.0 records a real unified diff as `patch`; `diff` is its numbered display diff.
    const diff = stringProp(result.details, "patch") ?? stringProp(result.details, "diff")
    s.event({ type: "file.changed", certainty: "known", path, ...(diff ? { diff } : {}), ...link })
  }
}

export const piDialect: PiDialect = {
  harness: HARNESS,
  name: NAME,
  format: FORMAT,
  toolKind,
  shellCommand: (name, input) => (SHELL_TOOLS.has(name) ? stringProp(input, "command") : undefined),
  commandStatus: (result) => bashStatus(result.text, result.failed),
  toolEffects: piToolEffects
}

export const decodeLine = makeLineDecoder({ schema: PiRecord, known: KNOWN_TYPES, ignored: METADATA_TYPES })

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/**
 * pi entries form a tree (`id` / `parentId`); `/tree` navigation leaves abandoned
 * branches in the file. The session is the path from the last entry back to the
 * root, so entries off that path are dropped. Returns `undefined` when every
 * entry is on the path (the common, linear case).
 */
export const activePath = (
  entries: ReadonlyArray<readonly [id: string, parentId: string | undefined]>,
  leaf: string | undefined = entries.at(-1)?.[0]
): ReadonlySet<string> | undefined => {
  const parents = new Map(entries)
  const path = new Set<string>()
  for (let id = leaf; id !== undefined && !path.has(id); id = parents.get(id)) path.add(id)
  return path.size === parents.size ? undefined : path
}

/** Whether a decoded line belongs to the active branch. Headers and id-less records always do. */
export const onPath = (path: ReadonlySet<string> | undefined) => (line: DecodedRecord<PiRecord>): boolean =>
  path === undefined || line._tag !== "Record" || line.record.type === "session" ||
  !("id" in line.record) || line.record.id === undefined || path.has(line.record.id)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PiState {
  readonly dialect: PiDialect
  readonly sessionId: SessionId
  readonly path: string
  readonly headerSeen: boolean
  readonly sawPrompt: boolean
  /** The open turn, if any. */
  readonly turn: string | undefined
  readonly cwd: string | undefined
  readonly tools: ReadonlyMap<string, OpenTool>
}

export const initialState = (sessionId: SessionId, path: string, dialect: PiDialect = piDialect): PiState => ({
  dialect,
  sessionId,
  path,
  headerSeen: false,
  sawPrompt: false,
  turn: undefined,
  cwd: undefined,
  tools: new Map()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decodeBlock = Schema.decodeUnknownOption(PiBlock)

/**
 * `<timestamp>_<id>.jsonl` → id. The timestamp has no `_` (`:` and `.` become `-`) but custom
 * session IDs may, so the ID is everything after the first `_`. Accepts a full path.
 */
export const idFromFileName = (file: string): string | undefined =>
  /^[^_]+_(.+)\.jsonl$/.exec(file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1))?.[1]

/** `<timestamp>_<id>` (a session's artifact directory) → id. */
export const idFromStem = (stem: string): string | undefined => /^\d{4}-\d{2}-\d{2}T[^_]*_(.+)$/.exec(stem)?.[1]

/** Exit status from pi's bash output trailer. */
export const bashStatus = (
  text: string,
  isError: boolean
): { readonly outcome: "succeeded" | "failed" | "interrupted"; readonly exitCode?: number } => {
  const exited = /Command exited with code (-?\d+)\s*$/.exec(text)
  if (exited) return { outcome: exited[1] === "0" ? "succeeded" : "failed", exitCode: Number(exited[1]) }
  if (/Command (?:timed out|aborted)/.test(text)) return { outcome: "interrupted" }
  return isError ? { outcome: "failed" } : { outcome: "succeeded" }
}

const asJson = (value: unknown) => value as Schema.Json

const prop = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined

/** Canonical usage from a pi-ai `Usage`: `input` excludes cache reads and `output` includes reasoning. */
export const usageOf = (model: string | undefined, usage: unknown) =>
  usageFields({
    model,
    inputTokens: tokenCount(prop(usage, "input")),
    cacheReadTokens: tokenCount(prop(usage, "cacheRead")),
    cacheWriteTokens: tokenCount(prop(usage, "cacheWrite")),
    outputTokens: tokenCount(prop(usage, "output")),
    reasoningTokens: tokenCount(prop(usage, "reasoning") ?? prop(usage, "reasoningTokens"))
  })

/** Emit `usage.recorded` for one model call, unless the record carries no counts. */
export const emitUsage = (s: RecordScope, model: string | undefined, usage: unknown): void => {
  const fields = usageOf(model, usage)
  if (Object.keys(fields).some((key) => key !== "model")) s.event({ type: "usage.recorded", certainty: "known", ...fields })
}

/**
 * A command the user ran from the prompt (`!cmd`). It has no tool call: the record holds the
 * command and its result, so it yields a started/completed pair with the recorded exit code.
 */
export const emitUserCommand = (
  state: PiState,
  s: RecordScope,
  command: {
    readonly command: string
    readonly output?: string | undefined
    readonly exitCode?: number | null | undefined
    readonly cancelled?: boolean | undefined
    readonly shell?: string
  }
): void => {
  const commandId = (s.options.nativeEventId ?? `record-${s.options.recordIndex}`) as CommandId
  const startedId = s.event({
    type: "command.started",
    certainty: "known",
    commandId,
    command: command.command,
    ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
    ...(command.shell !== undefined ? { shell: command.shell } : {})
  })
  const exitCode = typeof command.exitCode === "number" && Number.isInteger(command.exitCode) ? command.exitCode : undefined
  const outcome: CommandOutcome = command.cancelled === true
    ? "interrupted"
    : exitCode === undefined
    ? "unknown"
    : exitCode === 0
    ? "succeeded"
    : "failed"
  s.event({
    type: "command.completed",
    certainty: "known",
    commandId,
    outcome,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(command.output ? { stdout: command.output } : {}),
    derivedFrom: [startedId]
  })
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [PiState, ReadonlyArray<Emission>]

/** The scope for one record, with the dialect's provenance. */
export const recordScope = (
  state: PiState,
  recordIndex: number,
  record?: { readonly id?: string | undefined; readonly timestamp?: string | undefined }
): RecordScope =>
  new RecordScope({
    harness: state.dialect.harness,
    sessionId: state.sessionId,
    format: state.dialect.format,
    path: state.path,
    recordIndex,
    nativeEventId: record?.id,
    timestamp: record?.timestamp
  })

export const normalizeLine = (state: PiState, line: DecodedRecord<PiRecord>): Step => {
  if (line._tag === "Skip") return [state, []]
  if (line._tag !== "Record") {
    const s = recordScope(state, line.index)
    warnUndecodable(s, line, state.dialect.name)
    return [state, s.emissions]
  }

  const record = line.record
  const s = recordScope(state, line.index, record)

  switch (record.type) {
    case "session": {
      // A file holds one session; ignore any repeated header.
      if (state.headerSeen) return [state, []]
      const parent = record.parentSession ? idFromFileName(record.parentSession) : undefined
      s.metadata({
        ...(record.cwd !== undefined ? { projectPath: record.cwd } : {}),
        ...(record.version !== undefined ? { metadata: { sessionFormatVersion: record.version } } : {}),
        ...(parent !== undefined
          ? { relationships: [{ type: "fork", from: state.sessionId, to: makeSessionId(state.dialect.harness, parent) }] }
          : {})
      })
      s.event({ type: "session.started", certainty: "known" })
      return [{ ...state, headerSeen: true, cwd: record.cwd }, s.emissions]
    }
    case "model_change":
      if (record.modelId !== undefined) s.metadata({ metadata: { model: record.modelId } })
      return [state, s.emissions]
    case "session_info":
      if (record.name) s.metadata({ title: { value: record.name, priority: 40 } })
      return [state, s.emissions]
    case "usage":
      // A model call outside the conversation (e.g. `cache_warm`); it still consumed tokens.
      emitUsage(s, record.model, record.usage)
      return [state, s.emissions]
    case "compaction":
      s.event({ type: "context.compacted", certainty: "known", ...(record.summary ? { summary: record.summary } : {}) })
      return [state, s.emissions]
    case "branch_summary":
      if (record.summary) {
        s.event({
          type: "harness.notice",
          certainty: "known",
          kind: "injected_context",
          content: [{ type: "text", text: record.summary }]
        })
      }
      return [state, s.emissions]
    case "custom_message": {
      const text = textOf(record.content)
      if (text.length > 0) {
        s.event({ type: "harness.notice", certainty: "known", kind: "other", content: [{ type: "text", text }] })
      }
      return [state, s.emissions]
    }
    case "message":
      return normalizeMessage(state, record.message, s)
  }
}

const normalizeMessage = (initial: PiState, message: PiMessage, s: RecordScope): Step => {
  let state = initial
  switch (message.role) {
    case "user": {
      const content: Array<ContentBlock> = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content.flatMap((raw) => {
          const block = Option.getOrUndefined(decodeBlock(raw))
          return block?.type === "text" ? [{ type: "text" as const, text: block.text }] : []
        })
      if (content.length === 0) return [state, s.emissions]
      state = { ...state, turn: startTurn(s, state.turn, s.options.nativeEventId ?? String(s.options.recordIndex)) }
      s.event({ type: "user.message", certainty: "known", content })
      if (!state.sawPrompt) {
        s.metadata({ title: { value: titleFrom(textOf(content)), priority: 10 } })
        state = { ...state, sawPrompt: true }
      }
      return [state, s.emissions]
    }
    case "assistant": {
      if (message.model !== undefined) s.metadata({ metadata: { model: message.model } })
      for (const raw of message.content) {
        const block = Option.getOrUndefined(decodeBlock(raw))
        if (block === undefined) continue
        switch (block.type) {
          case "text":
            if (block.text.trim().length > 0) {
              s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: block.text }] })
            }
            break
          case "thinking":
            if (block.thinking.trim().length > 0) {
              s.event({
                type: "agent.reasoning",
                certainty: "known",
                content: block.thinking,
                representation: "provider_exposed"
              })
            }
            break
          case "toolCall":
            state = startTool(state, s, block)
            break
          case "image":
            break
        }
      }
      // A deferred response is a placeholder: the call's usage arrives with the response.
      if (message.stopReason !== "deferred") emitUsage(s, message.model, message.usage)
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        s.event({
          type: "harness.notice",
          certainty: "known",
          kind: message.stopReason === "aborted" ? "interruption" : "error",
          content: [{ type: "text", text: message.errorMessage ?? message.stopReason }]
        })
      }
      // `toolUse` continues the turn, and so does `deferred` (pi 1.0: the provider will deliver the
      // response later, so the turn's end is not recorded here); the other stop reasons end it.
      const outcome = message.stopReason === "stop" || message.stopReason === "length"
        ? "completed"
        : message.stopReason === "aborted"
        ? "interrupted"
        : message.stopReason === "error"
        ? "failed"
        : undefined
      if (outcome !== undefined) state = { ...state, turn: endTurn(s, state.turn, outcome) }
      return [state, s.emissions]
    }
    case "toolResult":
      return [completeTool(state, s, message), s.emissions]
    case "system":
      // The system prompt is harness configuration, not conversation.
      return [state, s.emissions]
    case "bashExecution":
      emitUserCommand(state, s, message)
      return [state, s.emissions]
    case "custom":
    case "hookMessage": {
      // Extension-injected text, as for `custom_message` entries.
      const text = textOf(message.content)
      if (text.length > 0) {
        s.event({ type: "harness.notice", certainty: "known", kind: "other", content: [{ type: "text", text }] })
      }
      return [state, s.emissions]
    }
  }
}

const startTool = (
  state: PiState,
  s: RecordScope,
  block: Extract<PiBlock, { type: "toolCall" }>
): PiState => {
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: block.id as ToolCallId,
    name: block.name,
    kind: state.dialect.toolKind(block.name),
    ...(block.arguments !== undefined ? { input: asJson(block.arguments) } : {})
  })
  const command = state.dialect.shellCommand(block.name, block.arguments)
  const commandStartedId = command === undefined ? undefined : s.event({
    type: "command.started",
    certainty: "known",
    commandId: block.id as CommandId,
    command,
    ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
    parentEventId: startedId,
    derivedFrom: [startedId]
  })
  const tools = new Map(state.tools).set(block.id, {
    startedId,
    name: block.name,
    input: block.arguments,
    ...(commandStartedId !== undefined ? { commandStartedId } : {})
  })
  return { ...state, tools }
}

const completeTool = (state: PiState, s: RecordScope, message: Extract<PiMessage, { role: "toolResult" }>): PiState => {
  const text = textOf(message.content ?? [])
  const failed = message.isError === true
  const toolCallId = message.toolCallId as ToolCallId
  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: text })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId, output: text })

  const open = state.tools.get(message.toolCallId)
  if (open === undefined) {
    s.warning("orphan_tool_result", "Tool results without a matching tool call")
    return state
  }
  const tools = new Map(state.tools)
  tools.delete(message.toolCallId)
  const link = { parentEventId: open.startedId, derivedFrom: [open.startedId, resultId] }
  const result: ToolResultFacts = { text, failed, details: message.details }

  const status = open.commandStartedId === undefined ? undefined : state.dialect.commandStatus(result)
  if (status !== undefined) {
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: message.toolCallId as CommandId,
      outcome: status.outcome,
      ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      stdout: text.replace(/\n*Command exited with code -?\d+\s*$/, ""),
      ...link
    })
  }

  state.dialect.toolEffects(s, open, result, link)
  return { ...state, tools }
}
