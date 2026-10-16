import {
  emitPlan,
  endTurn,
  type MetadataPatch,
  makeRecordDecoder,
  normalizeTimestamp,
  planList,
  RecordScope,
  startTurn,
  stringProp,
  titleFrom,
  tokenCount,
  usageFields,
  warnUndecodable
} from "@agentbridge/core"
import type { Emission } from "@agentbridge/core"
import {
  type CommandId,
  type CommandOutcome,
  type ContentBlock,
  type EventId,
  makeSessionId,
  type SessionId,
  type SessionRelationship,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import { Option, Schema } from "effect"
import {
  type AmpBlock,
  AmpBlock as AmpBlockSchema,
  AmpEnvironment,
  type AmpMessage,
  AmpMessage as AmpMessageSchema,
  AmpRelationship,
  type AmpThread,
  type AmpToolRun,
  AmpUsage,
  KNOWN_BLOCKS,
  KNOWN_ROLES
} from "./schema/AmpThread.ts"

export const HARNESS = "amp"
export const NAME = "Amp"
export const FORMAT = "amp-thread-json"

// ---------------------------------------------------------------------------
// Tool table: the only place native tool names are interpreted
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  read_mcp_resource: "read",
  edit_file: "edit",
  create_file: "edit",
  apply_patch: "edit",
  undo_edit: "edit",
  format_file: "edit",
  delete_file: "delete",
  Bash: "execute",
  shell_command: "execute",
  Grep: "search",
  glob: "search",
  finder: "search",
  web_search: "search",
  find_thread: "search",
  read_web_page: "fetch",
  read_thread: "fetch",
  todo_write: "think",
  todo_read: "think",
  oracle: "think"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

/** Shell tools: the command line and working-directory argument names. */
const SHELL_TOOLS: Record<string, { readonly command: string; readonly cwd: string }> = {
  Bash: { command: "cmd", cwd: "cwd" },
  shell_command: { command: "command", cwd: "workdir" }
}

/** Amp's `todo_write` statuses. */
const TODO_STATUS: Record<string, string> = { todo: "pending", "in-progress": "in_progress", completed: "completed" }

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

const roleOf = (json: unknown) => stringProp(json, "role")

export const decodeMessage = makeRecordDecoder({ schema: AmpMessageSchema, typeOf: roleOf, known: KNOWN_ROLES, ignored: new Set() })
const decodeBlock = makeRecordDecoder({ schema: AmpBlockSchema, known: KNOWN_BLOCKS, ignored: new Set() })
const decodeUsage = Schema.decodeUnknownOption(AmpUsage)
const decodeRelationship = Schema.decodeUnknownOption(AmpRelationship)
const decodeEnvironment = Schema.decodeUnknownOption(AmpEnvironment)

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

/** Epoch milliseconds or a date string → RFC 3339, or undefined. */
export const instant = (value: number | string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value === "string") return normalizeTimestamp(value)
  if (!Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** `file:///work/demo` → `/work/demo`; plain paths pass through. */
export const pathFromUri = (uri: string): string | undefined => {
  if (!uri.startsWith("file://")) return uri.includes("://") ? undefined : uri
  try {
    return decodeURIComponent(uri.slice("file://".length).replace(/^localhost(?=\/)/, ""))
  } catch {
    return undefined
  }
}

/**
 * Canonical usage from one assistant message. Anthropic calls record uncached input in
 * `inputTokens` and cache writes in `cacheCreationInputTokens`. Every other provider path
 * records `totalInputTokens` = prompt tokens and puts the uncached share in
 * `cacheCreationInputTokens` (with `inputTokens: 0`), which is not a cache write.
 */
export const usageOf = (usage: typeof AmpUsage.Type) => {
  const total = tokenCount(usage.totalInputTokens)
  const input = tokenCount(usage.inputTokens)
  const cacheRead = tokenCount(usage.cacheReadInputTokens ?? undefined)
  const cacheCreation = tokenCount(usage.cacheCreationInputTokens ?? undefined)
  const output = tokenCount(usage.outputTokens)
  // Amp writes zero counts when a provider omitted usage; that is absence, not a measurement.
  if ((total ?? input ?? 0) === 0 && (output ?? 0) === 0) return undefined
  const anthropic = usage.model !== undefined ? /claude|anthropic/i.test(usage.model) : (input ?? 0) > 0
  const uncached = anthropic
    ? input
    : total !== undefined
    ? Math.max(0, total - (cacheRead ?? 0))
    : input
  return usageFields({
    model: usage.model,
    inputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: anthropic ? cacheCreation : undefined,
    outputTokens: output
  })
}

const asJson = (value: unknown) => value as Schema.Json

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Strip a markdown code fence around a diff, if any. */
const unfence = (diff: string) => /^```[a-z]*\n([\s\S]*?)\n?```\s*$/.exec(diff.trim())?.[1] ?? diff

/** Outcome of a shell run: `{output, exitCode}` once done. */
export const shellOutcome = (run: AmpToolRun): {
  readonly outcome: CommandOutcome
  readonly exitCode?: number
  readonly stdout?: string
} => {
  const result = recordOf(run.result)
  const output = typeof run.result === "string" ? run.result : stringProp(result, "output")
  const exitCode = result?.["exitCode"]
  const stdout = output !== undefined ? { stdout: output } : {}
  switch (run.status) {
    case "done":
      if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
        return { outcome: exitCode === 0 ? "succeeded" : "failed", exitCode, ...stdout }
      }
      return { outcome: "unknown", ...stdout }
    case "error":
      return { outcome: "failed", ...stdout }
    case "cancelled":
    case "rejected-by-user":
      return { outcome: "interrupted", ...stdout }
    default:
      return { outcome: "unknown", ...stdout }
  }
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "error", "cancelled", "rejected-by-user"])

/** File operations named in an `apply_patch` body. */
export const patchOperations = (patch: string): ReadonlyArray<{
  readonly op: "add" | "update" | "delete"
  readonly path: string
  readonly movePath?: string
}> => {
  const ops: Array<{ op: "add" | "update" | "delete"; path: string; movePath?: string }> = []
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      ops.push({ op: header[1] === "Add" ? "add" : header[1] === "Update" ? "update" : "delete", path: header[2]!.trim() })
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    const last = ops.at(-1)
    if (move && last?.op === "update") last.movePath = move[1]!.trim()
  }
  return ops
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly command: boolean
}

export interface AmpState {
  readonly sessionId: SessionId
  readonly path: string
  readonly projectPath: string | undefined
  readonly sawPrompt: boolean
  readonly turn: string | undefined
  readonly tools: Readonly<Record<string, OpenTool>>
  /** Paths this thread has read or written, to tell overwrites from creations. */
  readonly seenPaths: ReadonlySet<string>
}

export const initialState = (sessionId: SessionId, path: string, projectPath: string | undefined): AmpState => ({
  sessionId,
  path,
  projectPath,
  sawPrompt: false,
  turn: undefined,
  tools: {},
  seenPaths: new Set()
})

type Step = readonly [AmpState, ReadonlyArray<Emission>]

const scopeBase = (state: AmpState, recordIndex: number) => ({
  harness: HARNESS,
  sessionId: state.sessionId,
  format: FORMAT,
  path: state.path,
  recordIndex
})

// ---------------------------------------------------------------------------
// Thread header
// ---------------------------------------------------------------------------

/** Thread-level facts: where it ran, model, version and links to other threads. */
export const threadFacts = (thread: AmpThread, sessionId: SessionId): {
  readonly projectPath: string | undefined
  readonly startedAt: string | undefined
  readonly patch: MetadataPatch
} => {
  const initial = Option.getOrUndefined(decodeEnvironment(thread.env))?.initial
  const tree = recordOf(initial?.trees?.[0])
  const projectPath = [initial?.workingDirectory, initial?.workspaceRoot, stringProp(tree, "uri")]
    .flatMap((value) => (value === undefined ? [] : [pathFromUri(value)]))
    .find((value): value is string => value !== undefined && value.length > 0)
  const clientVersion = stringProp(initial?.platform, "clientVersion")
  const model = initial?.tags?.flatMap((tag) => (typeof tag === "string" && tag.startsWith("model:") ? [tag.slice(6)] : []))
    .find((m) => m.length > 0 && m !== "undefined")

  const link = (other: string): SessionId => makeSessionId(HARNESS, other)
  const relationships: Array<SessionRelationship> = []
  const add = (relationship: SessionRelationship) => {
    if (relationship.from === relationship.to) return
    if (!relationships.some((r) => r.type === relationship.type && r.from === relationship.from && r.to === relationship.to)) {
      relationships.push(relationship)
    }
  }
  if (thread.originThreadID) add({ type: "fork", from: sessionId, to: link(thread.originThreadID) })
  for (const raw of thread.relationships ?? []) {
    const relationship = Option.getOrUndefined(decodeRelationship(raw))
    if (relationship === undefined) continue
    const other = link(relationship.threadID)
    // `role` is this thread's role. A handoff starts a new thread that continues the work.
    const type = relationship.type === "fork" ? "fork" : relationship.type === "handoff" ? "resume" : relationship.type === "mention" ? "related" : undefined
    if (type === undefined) continue
    if (type === "related") add({ type, from: sessionId, to: other })
    else if (relationship.role === "child") add({ type, from: sessionId, to: other })
    else if (relationship.role === "parent") add({ type, from: other, to: sessionId })
  }

  const startedAt = instant(thread.created)
  const patch: MetadataPatch = {
    ...(thread.title ? { title: { value: thread.title, priority: 30 } } : {}),
    ...(projectPath !== undefined ? { projectPath } : {}),
    ...(clientVersion !== undefined ? { harnessVersion: clientVersion } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(relationships.length > 0 ? { relationships } : {}),
    metadata: {
      ...(model !== undefined ? { model } : {}),
      ...(thread.agentMode !== undefined ? { agentMode: thread.agentMode } : {}),
      ...(thread.mainThreadID !== undefined ? { mainThreadId: thread.mainThreadID } : {})
    }
  }
  return { projectPath, startedAt, patch }
}

/** Emissions that precede the messages: session metadata and `session.started`. */
export const headerEmissions = (state: AmpState, thread: AmpThread, facts: ReturnType<typeof threadFacts>): ReadonlyArray<Emission> => {
  const s = new RecordScope({ ...scopeBase(state, 0), nativeEventId: thread.id, timestamp: facts.startedAt })
  s.metadata(facts.patch)
  s.event({ type: "session.started", certainty: "known" })
  return s.emissions
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Decode a message's blocks, warning about the ones that cannot be used. */
const blocksOf = (s: RecordScope, message: AmpMessage, index: number): ReadonlyArray<AmpBlock> => {
  const blocks: Array<AmpBlock> = []
  for (const raw of message.content) {
    const decoded = decodeBlock(index, raw)
    if (decoded._tag === "Record") blocks.push(decoded.record)
    else if (decoded._tag === "Unknown") s.warning("unknown_record_type", `Ignored unknown ${NAME} content block type "${decoded.nativeType}"`)
    else if (decoded._tag === "Malformed") s.warning("malformed_record", `Skipped ${NAME} content blocks that do not match the expected shape`)
  }
  return blocks
}

export const normalizeMessage = (state: AmpState, [raw, index]: readonly [unknown, number]): Step => {
  const decoded = decodeMessage(index, raw)
  if (decoded._tag === "Skip") return [state, []]
  if (decoded._tag !== "Record") {
    const s = new RecordScope(scopeBase(state, index))
    warnUndecodable(s, decoded, NAME)
    return [state, s.emissions]
  }
  const message = decoded.record
  const nativeEventId = message.messageId === undefined ? undefined : String(message.messageId)
  switch (message.role) {
    case "user": {
      const timestamp = instant(message.meta?.sentAt) ?? instant(message.createdAt)
      const s = new RecordScope({ ...scopeBase(state, index), nativeEventId, timestamp })
      return [normalizeUser(state, s, message, blocksOf(s, message, index)), s.emissions]
    }
    case "assistant": {
      const usage = message.usage === undefined ? undefined : Option.getOrUndefined(decodeUsage(message.usage))
      const timestamp = instant(message.createdAt) ?? normalizeTimestamp(usage?.timestamp)
      const s = new RecordScope({ ...scopeBase(state, index), nativeEventId, timestamp })
      return [normalizeAssistant(state, s, message, blocksOf(s, message, index), usage), s.emissions]
    }
    case "info": {
      const s = new RecordScope({ ...scopeBase(state, index), nativeEventId, timestamp: instant(message.createdAt) })
      blocksOf(s, message, index).forEach((block, n) => {
        if (block.type === "manual_bash_invocation") userShell(state, s, block, `${nativeEventId ?? index}:bash:${n}`)
      })
      return [state, s.emissions]
    }
  }
}

const normalizeUser = (initial: AmpState, s: RecordScope, message: AmpMessage, blocks: ReadonlyArray<AmpBlock>): AmpState => {
  let state = initial
  const content: Array<ContentBlock> = []
  const notices: Array<string> = []
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.hidden === true) {
        if (block.text.trim().length > 0) notices.push(block.text)
      } else if (block.text.trim().length > 0) content.push({ type: "text", text: block.text })
    } else if (block.type === "image") {
      const uri = block.source?.url
      if (uri !== undefined) content.push({ type: "image", uri, ...(block.source?.mediaType ? { mimeType: block.source.mediaType } : {}) })
    } else if (block.type === "tool_result") {
      state = toolResult(state, s, block.toolUseID, block.run)
    }
  }
  if (content.length > 0) {
    state = { ...state, turn: startTurn(s, state.turn, s.options.nativeEventId ?? String(s.options.recordIndex)) }
    s.event({ type: "user.message", certainty: "known", content })
    const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
    if (!state.sawPrompt && text.length > 0) {
      s.metadata({ title: { value: titleFrom(text), priority: 10 } })
      state = { ...state, sawPrompt: true }
    }
  }
  for (const text of notices) {
    s.event({ type: "harness.notice", certainty: "known", kind: "injected_context", content: [{ type: "text", text }] })
  }
  return state
}

const normalizeAssistant = (
  initial: AmpState,
  s: RecordScope,
  message: Extract<AmpMessage, { role: "assistant" }>,
  blocks: ReadonlyArray<AmpBlock>,
  usage: typeof AmpUsage.Type | undefined
): AmpState => {
  let state = initial
  const status = message.state?.type
  if (usage?.model !== undefined) s.metadata({ metadata: { model: usage.model } })
  // Usage belongs to one model call; a message still streaming has partial counts.
  const counts = usage === undefined || status === "streaming" ? undefined : usageOf(usage)
  if (counts !== undefined) s.event({ type: "usage.recorded", certainty: "known", ...counts })

  let calledTools = false
  for (const block of blocks) {
    switch (block.type) {
      case "thinking":
        if (block.thinking.trim().length > 0) {
          s.event({ type: "agent.reasoning", certainty: "known", content: block.thinking, representation: "provider_exposed" })
        }
        break
      case "text":
        if (block.text.trim().length > 0) s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: block.text }] })
        break
      case "tool_use":
      case "server_tool_use":
        calledTools = true
        state = toolStarted(state, s, block.id, block.name, block.input)
        break
      default:
        break
    }
  }

  if (status === "cancelled") return { ...state, turn: endTurn(s, state.turn, "interrupted") }
  if (status === "error") return { ...state, turn: endTurn(s, state.turn, "failed") }
  if (status === "complete" && !calledTools) {
    const recorded = message.state?.stopReason === "end_turn" || message.turnElapsedMs !== undefined
    return {
      ...state,
      turn: endTurn(s, state.turn, "completed", {
        certainty: recorded ? "known" : "inferred",
        durationMs: message.turnElapsedMs
      })
    }
  }
  return state
}

const toolStarted = (state: AmpState, s: RecordScope, id: string, name: string, input: unknown): AmpState => {
  const toolCallId = id as ToolCallId
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId,
    name,
    kind: toolKind(name),
    ...(input !== undefined ? { input: asJson(input) } : {})
  })
  const shell = SHELL_TOOLS[name]
  const command = shell === undefined ? undefined : stringProp(input, shell.command)
  if (shell !== undefined && command !== undefined) {
    const cwd = stringProp(input, shell.cwd) ?? state.projectPath
    s.event({
      type: "command.started",
      certainty: "known",
      commandId: id as CommandId,
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      parentEventId: startedId,
      derivedFrom: [startedId]
    })
  }
  return { ...state, tools: { ...state.tools, [id]: { startedId, name, input, command: command !== undefined } } }
}

/** Model-facing output of a finished tool. */
const toolOutput = (name: string, result: unknown): unknown => {
  const record = recordOf(result)
  if (name === "Read") return record?.["isImage"] === true ? undefined : record?.["content"] ?? result
  if (SHELL_TOOLS[name] !== undefined) return record?.["output"] ?? result
  if (name === "edit_file") return record?.["diff"] ?? result
  return result
}

const toolResult = (initial: AmpState, s: RecordScope, toolUseID: string, run: AmpToolRun): AmpState => {
  const open = initial.tools[toolUseID]
  if (open === undefined) {
    s.warning("orphan_tool_result", `Ignored ${NAME} tool results without a matching tool call`)
    return initial
  }
  if (!TERMINAL.has(run.status)) return initial
  const { [toolUseID]: _closed, ...tools } = initial.tools
  let state: AmpState = { ...initial, tools }
  const toolCallId = toolUseID as ToolCallId
  const done = run.status === "done"
  const output = done ? toolOutput(open.name, run.result) : undefined
  const resultId = done
    ? s.event({ type: "tool.completed", certainty: "known", toolCallId, ...(output !== undefined && output !== null ? { output: asJson(output) } : {}) })
    : s.event({ type: "tool.failed", certainty: "known", toolCallId, message: run.error?.message ?? run.status })
  const link = { parentEventId: open.startedId, derivedFrom: [open.startedId, resultId] }

  if (open.command) {
    const outcome = shellOutcome(run)
    s.event({ type: "command.completed", certainty: "known", commandId: toolUseID as CommandId, ...outcome, ...link })
  }
  if (!done) return state

  const result = recordOf(run.result)
  const path = stringProp(open.input, "path")
  const seen = (p: string) => {
    state = { ...state, seenPaths: new Set([...state.seenPaths, p]) }
  }
  switch (open.name) {
    case "Read":
      if (path !== undefined && result?.["isDirectory"] !== true) {
        s.event({ type: "file.read", certainty: "known", path, ...link })
        seen(path)
      }
      break
    case "edit_file":
    case "undo_edit":
      if (path !== undefined) {
        const diff = stringProp(result, "diff")
        s.event({ type: "file.changed", certainty: "known", path, ...(diff !== undefined ? { diff: unfence(diff) } : {}), ...link })
        seen(path)
      }
      break
    case "create_file":
      // create_file also overwrites, and records nothing that says which happened.
      if (path !== undefined) {
        if (state.seenPaths.has(path)) s.event({ type: "file.changed", certainty: "inferred", path, ...link })
        else s.event({ type: "file.created", certainty: "inferred", path, ...link })
        seen(path)
      }
      break
    case "delete_file":
      if (path !== undefined) s.event({ type: "file.deleted", certainty: "known", path, ...link })
      break
    case "apply_patch": {
      const patch = stringProp(open.input, "patchText")
      for (const op of patch === undefined ? [] : patchOperations(patch)) {
        if (op.op === "add") s.event({ type: "file.created", certainty: "known", path: op.path, ...link })
        else if (op.op === "delete") s.event({ type: "file.deleted", certainty: "known", path: op.path, ...link })
        else if (op.movePath !== undefined) s.event({ type: "file.changed", certainty: "known", path: op.movePath, previousPath: op.path, ...link })
        else s.event({ type: "file.changed", certainty: "known", path: op.path, ...link })
        seen(op.movePath ?? op.path)
      }
      break
    }
    case "todo_write": {
      const todos = planList(open.input, "todos")
      const entries = Array.isArray(todos)
        ? todos.map((todo) => {
          const entry = recordOf(todo)
          const status = typeof entry?.["status"] === "string" ? TODO_STATUS[entry["status"]] ?? entry["status"] : entry?.["status"]
          return entry === undefined ? todo : { ...entry, status }
        })
        : todos
      emitPlan(s, entries, "content", { certainty: "known", ...link })
      break
    }
    default:
      break
  }
  return state
}

/** `$ cmd` typed by the user in the prompt box. */
const userShell = (
  state: AmpState,
  s: RecordScope,
  block: Extract<AmpBlock, { type: "manual_bash_invocation" }>,
  id: string
) => {
  const commandId = id as CommandId
  const command = [block.args.cmd, ...(block.args.args ?? [])].join(" ")
  const cwd = block.args.cwd ?? state.projectPath
  const startedId = s.event({ type: "command.started", certainty: "known", commandId, command, ...(cwd !== undefined ? { cwd } : {}) })
  if (!TERMINAL.has(block.toolRun.status)) return
  s.event({
    type: "command.completed",
    certainty: "known",
    commandId,
    ...shellOutcome(block.toolRun),
    parentEventId: startedId,
    derivedFrom: [startedId]
  })
}
