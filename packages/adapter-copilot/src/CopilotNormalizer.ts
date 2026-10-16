import {
  type DecodedRecord,
  type Emission,
  emitPlan,
  endTurn,
  makeLineDecoder,
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
  type NoticeKind,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import type { Schema } from "effect"
import {
  type AssistantMessageData,
  CopilotRecord,
  IGNORED_TYPES,
  KNOWN_TYPES,
  type SubagentData,
  type ToolCompleteData,
  type ToolRequest,
  type ToolStartData
} from "./schema/CopilotRecord.ts"

export const HARNESS = "copilot"
export const NAME = "GitHub Copilot CLI"
export const FORMAT = "copilot-events-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native Copilot tool names are interpreted)
// ---------------------------------------------------------------------------

/** Built-in tools of the Copilot CLI 1.0.x runtime. MCP tools fall through to `other`. */
const TOOL_KINDS: Record<string, ToolKind> = {
  bash: "execute",
  powershell: "execute",
  read_bash: "execute",
  write_bash: "execute",
  stop_bash: "execute",
  list_bash: "execute",
  read_powershell: "execute",
  write_powershell: "execute",
  stop_powershell: "execute",
  list_powershell: "execute",
  view: "read",
  str_replace_editor: "edit",
  create: "edit",
  edit: "edit",
  str_replace: "edit",
  insert: "edit",
  apply_patch: "edit",
  glob: "search",
  grep: "search",
  rg: "search",
  search: "search",
  web_search: "search",
  search_code_subagent: "search",
  web_fetch: "fetch",
  fetch_copilot_cli_documentation: "fetch",
  update_todo: "think",
  report_intent: "think",
  report_progress: "think",
  task_complete: "think",
  exit_plan_mode: "think"
}

/** Shell tools whose calls are commands. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"])

/** The tool that spawns a subagent. Its `prompt` argument is the subagent's prompt. */
const TASK_TOOL = "task"

export const toolKind = (name: string, input?: unknown): ToolKind => {
  if (name === "str_replace_editor" && stringProp(input, "command") === "view") return "read"
  return TOOL_KINDS[name] ?? "other"
}

export const decodeLine = makeLineDecoder({ schema: CopilotRecord, known: KNOWN_TYPES, ignored: IGNORED_TYPES })

// ---------------------------------------------------------------------------
// Text classification
// ---------------------------------------------------------------------------

/**
 * `user.message` also carries text the user did not type: hidden skill injections
 * (`source: "skill-<name>"`), inter-agent prompts (`agent-<id>`), autopilot continuations.
 * Copilot's own timeline shows a message as the user's only when it has no source or
 * comes from a remote command (`command-…`) or a scheduled prompt (`schedule-…`).
 */
export const classifyUserMessage = (data: {
  readonly source?: string | null | undefined
  readonly isAutopilotContinuation?: boolean | null | undefined
}): { readonly _tag: "Prompt" } | { readonly _tag: "Notice"; readonly kind: NoticeKind } => {
  if (data.isAutopilotContinuation === true) return { _tag: "Notice", kind: "other" }
  const source = data.source
  if (source === undefined || source === null || source === "" || source === "user") return { _tag: "Prompt" }
  if (source.startsWith("command-") || source.startsWith("schedule-")) return { _tag: "Prompt" }
  if (source.startsWith("skill-")) return { _tag: "Notice", kind: "injected_context" }
  if (source.startsWith("agent-")) return { _tag: "Notice", kind: "task_notification" }
  return { _tag: "Notice", kind: "other" }
}

const EXIT_CODE = /(?:exited|completed) with exit code (-?\d+)/g
const EXIT_TRAILER = /\n?<[^<>\n]*(?:exited|completed) with exit code -?\d+>\s*$/

/** The exit code of a shell tool call, from the most structured source available. */
export const exitCodeOf = (data: ToolCompleteData): number | undefined => {
  if (data.shellExecution != null) return data.shellExecution.exitCode
  for (const block of data.result?.contents ?? []) {
    if (typeof block !== "object" || block === null) continue
    const record = block as Record<string, unknown>
    if ((record["type"] === "shell_exit" || record["type"] === "terminal") && typeof record["exitCode"] === "number") {
      return record["exitCode"]
    }
  }
  for (const text of [data.result?.content, data.result?.detailedContent]) {
    const matches = [...(text ?? "").matchAll(EXIT_CODE)]
    const last = matches.at(-1)
    if (last !== undefined) return Number(last[1])
  }
  return undefined
}

/** `update_todo` takes a markdown checklist. */
export const todoEntries = (markdown: string) =>
  [...markdown.matchAll(/^\s*(?:[-*]|\d+\.)\s*\[([ xX~>/-])\]\s+(.+?)\s*$/gm)].map((match) => ({
    content: match[2]!,
    status: match[1] === " " ? "pending" : match[1] === "x" || match[1] === "X" ? "completed" : "in_progress"
  }))

/** `*** Add File: path` headers of an `apply_patch` body. */
const patchHeaders = (patch: string) =>
  [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((match) => ({
    change: match[1] === "Add" ? "created" as const : match[1] === "Delete" ? "deleted" as const : "changed" as const,
    path: match[2]!.trim()
  }))

const FORKED_FROM = /^Forked from .*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

const asJson = (value: unknown) => value as Schema.Json

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Which part of an `events.jsonl` a session reads. Subagents run inline in their parent's
 * log, so a subagent session is the parent's file filtered to the events it attributed
 * to that agent.
 */
export type View =
  | { readonly _tag: "Root" }
  | { readonly _tag: "Agent"; readonly agentId: string }

interface OpenCall {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly commandStartedId: EventId | undefined
  /** `mode: "async"` / `detach`: the tool returns while the command keeps running. */
  readonly background: boolean
}

interface PendingChunks {
  readonly key: string
  readonly texts: Array<string>
  requested: boolean
  index: number
  nativeId: string | undefined
  timestamp: string | undefined
}

/**
 * Normalizer state. It lives in the `mapAccum` accumulator, created fresh for every read,
 * and is updated in place: open calls and task prompts are looked up on every record.
 */
export interface CopilotState {
  readonly sessionId: SessionId
  readonly path: string
  readonly view: View
  /** Native ID of the session whose file this is; subagent session IDs extend it. */
  readonly rootNativeId: string
  started: boolean
  sawPrompt: boolean
  turn: string | undefined
  /** The run produced a reply without tool requests; the next `assistant.turn_end` ends the turn. */
  replied: boolean
  readonly calls: Map<string, OpenCall>
  /** Tool requests from `assistant.message` not yet seen executing. */
  readonly requests: Map<string, ToolRequest>
  /** `task` call ID → prompt, for every agent in the file. */
  readonly taskPrompts: Map<string, string>
  /** `task` calls this view made. */
  readonly ownTasks: Set<string>
  chunks: PendingChunks | undefined
  lastUsageCall: string | undefined
  lastReasoning: string | undefined
  cwd: string | undefined
  model: string | undefined
  sawStart: boolean
}

export const initialState = (sessionId: SessionId, path: string, rootNativeId: string, view: View): CopilotState => ({
  sessionId,
  path,
  view,
  rootNativeId,
  started: false,
  sawPrompt: false,
  turn: undefined,
  replied: false,
  calls: new Map(),
  requests: new Map(),
  taskPrompts: new Map(),
  ownTasks: new Set(),
  chunks: undefined,
  lastUsageCall: undefined,
  lastReasoning: undefined,
  cwd: undefined,
  model: undefined,
  sawStart: false
})

type Step = readonly [CopilotState, ReadonlyArray<Emission>]

const scopeFor = (state: CopilotState, index: number, nativeId: string | undefined, timestamp: string | undefined) =>
  new RecordScope({
    harness: HARNESS,
    sessionId: state.sessionId,
    format: FORMAT,
    path: state.path,
    recordIndex: index,
    nativeEventId: nativeId,
    timestamp
  })

/** The agent a record belongs to: `agentId`, or the deprecated `data.parentToolCallId`. */
const ownerOf = (record: CopilotRecord): string | undefined => {
  if (record.agentId != null) return record.agentId
  const data = record.data as { readonly parentToolCallId?: unknown }
  return typeof data.parentToolCallId === "string" ? data.parentToolCallId : undefined
}

const isSubagentLifecycle = (
  record: CopilotRecord
): record is Extract<CopilotRecord, { type: "subagent.started" | "subagent.completed" | "subagent.failed" }> =>
  record.type === "subagent.started" || record.type === "subagent.completed" || record.type === "subagent.failed"

/** The agent a subagent lifecycle event is about. */
export const subagentIdOf = (record: { readonly agentId?: string | null | undefined; readonly data: SubagentData }) =>
  record.agentId ?? record.data.toolCallId

const inView = (state: CopilotState, record: CopilotRecord): boolean => {
  if (isSubagentLifecycle(record)) return state.view._tag === "Agent" && subagentIdOf(record) === state.view.agentId
  const owner = ownerOf(record)
  return state.view._tag === "Root" ? owner === undefined : owner === state.view.agentId
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export const onHalt = (state: CopilotState): ReadonlyArray<Emission> => flushChunks(state)

export const normalizeLine = (state: CopilotState, line: DecodedRecord<CopilotRecord>): Step => {
  if (line._tag === "Skip") return [state, []]
  if (line._tag !== "Record") {
    // Undecodable lines cannot be attributed to an agent; report them once, on the file's own session.
    if (state.view._tag !== "Root") return [state, []]
    const s = scopeFor(state, line.index, undefined, undefined)
    warnUndecodable(s, line, NAME)
    return [state, s.emissions]
  }
  const record = line.record
  const s = scopeFor(state, line.index, record.id ?? undefined, record.timestamp ?? undefined)
  observe(state, record, s)
  if (!inView(state, record)) return [state, s.emissions]
  // A chunk series cut short by another reply is flushed before that reply.
  const flushed = record.type === "assistant.message" && state.chunks !== undefined && state.chunks.key !== chunkKey(record.data)
    ? flushChunks(state)
    : []
  if (!state.started) {
    s.event({ type: "session.started", certainty: "known" })
    state.started = true
  }
  handle(state, record, s, line.index)
  return [state, flushed.length === 0 ? s.emissions : [...flushed, ...s.emissions]]
}

/** Facts every view needs, whichever agent the record belongs to. */
const observe = (state: CopilotState, record: CopilotRecord, s: RecordScope) => {
  switch (record.type) {
    case "session.start": {
      if (state.sawStart) return
      state.sawStart = true
      const { context } = record.data
      state.cwd = context?.cwd ?? state.cwd
      state.model = record.data.selectedModel ?? state.model
      // Subagent sessions share the parent's working directory and harness version.
      if (state.view._tag === "Agent") {
        s.metadata({
          ...(context?.cwd != null ? { projectPath: context.cwd } : {}),
          ...(record.data.copilotVersion != null ? { harnessVersion: record.data.copilotVersion } : {})
        })
      }
      return
    }
    case "session.context_changed":
      if (record.data.pendingGitContext !== true && record.data.cwd != null) state.cwd = record.data.cwd
      return
    case "session.model_change":
      state.model = record.data.newModel
      return
    case "tool.execution_start": {
      const prompt = stringProp(record.data.arguments, "prompt")
      if (record.data.toolName === TASK_TOOL && prompt !== undefined) state.taskPrompts.set(record.data.toolCallId, prompt)
      return
    }
    case "subagent.started":
      if (state.ownTasks.has(record.data.toolCallId)) {
        s.metadata({
          relationships: [{
            type: "child",
            from: state.sessionId,
            to: makeSessionId(HARNESS, `${state.rootNativeId}/${subagentIdOf(record)}`)
          }]
        })
      }
      return
    default:
      return
  }
}

const notice = (s: RecordScope, kind: NoticeKind, text: string) =>
  s.event({ type: "harness.notice", certainty: "known", kind, content: [{ type: "text", text }] })

const handle = (state: CopilotState, record: CopilotRecord, s: RecordScope, index: number): void => {
  switch (record.type) {
    case "session.start": {
      const { data } = record
      const context = data.context
      s.metadata({
        ...(context?.cwd != null ? { projectPath: context.cwd } : {}),
        ...(data.copilotVersion != null ? { harnessVersion: data.copilotVersion } : {}),
        ...(data.startTime != null ? { startedAt: data.startTime } : {}),
        metadata: {
          ...(data.selectedModel != null ? { model: data.selectedModel } : {}),
          ...(context?.branch != null ? { gitBranch: context.branch } : {}),
          ...(context?.headCommit != null ? { gitCommit: context.headCommit } : {}),
          ...(context?.repository != null ? { repository: context.repository } : {})
        }
      })
      return
    }
    case "session.resume":
      if (record.data.selectedModel != null) s.metadata({ metadata: { model: record.data.selectedModel } })
      return
    case "session.model_change":
      s.metadata({ metadata: { model: record.data.newModel } })
      return
    case "session.context_changed": {
      const context = record.data
      if (context.pendingGitContext === true) return
      s.metadata({
        metadata: {
          ...(context.branch != null ? { gitBranch: context.branch } : {}),
          ...(context.headCommit != null ? { gitCommit: context.headCommit } : {}),
          ...(context.repository != null ? { repository: context.repository } : {})
        }
      })
      return
    }
    case "session.error":
      notice(s, "error", record.data.message)
      return
    case "session.warning":
      notice(s, "other", record.data.message)
      return
    case "session.info": {
      // A fork copies the source's events and appends "Forked from <name> (<id>) …".
      const forked = record.data.infoType === "fork" ? FORKED_FROM.exec(record.data.message) : null
      if (forked !== null && makeSessionId(HARNESS, forked[1]!) !== state.sessionId) {
        s.metadata({ relationships: [{ type: "fork", from: state.sessionId, to: makeSessionId(HARNESS, forked[1]!) }] })
      }
      return
    }
    case "session.shutdown": {
      const { data } = record
      if (data.shutdownType === "error") notice(s, "error", data.errorReason ?? "Session ended with an error")
      // Totals for the process lifetime, not per model call: metadata, never usage events.
      if (data.modelMetrics != null) s.metadata({ metadata: { modelMetrics: asJson(data.modelMetrics) } })
      if (state.turn !== undefined) {
        state.turn = endTurn(s, state.turn, "unknown", { certainty: "inferred" })
        state.replied = false
      }
      return
    }
    case "session.compaction_complete":
      if (record.data.success) {
        s.event({
          type: "context.compacted",
          certainty: "known",
          ...(record.data.summaryContent != null ? { summary: record.data.summaryContent } : {})
        })
      }
      return
    case "user.message": {
      const { data } = record
      if (data.content.trim().length === 0) return
      const classified = classifyUserMessage(data)
      if (classified._tag === "Notice") {
        notice(s, classified.kind, data.content)
        return
      }
      // A steering message joins the run in flight; any other prompt starts a run.
      if (state.turn === undefined || data.delivery !== "steering") {
        state.turn = startTurn(s, state.turn, record.id ?? String(index))
        state.replied = false
      }
      s.event({ type: "user.message", certainty: "known", content: [{ type: "text", text: data.content }] })
      if (!state.sawPrompt) {
        s.metadata({ title: { value: titleFrom(data.content), priority: 10 } })
        state.sawPrompt = true
      }
      return
    }
    case "assistant.turn_start":
      // One per model call of the agent loop. A run without a prompt (a system notification
      // woke the agent) starts at its first model call.
      if (state.view._tag === "Root" && state.turn === undefined) {
        state.turn = startTurn(s, undefined, record.id ?? String(index))
        state.replied = false
      }
      return
    case "assistant.turn_end":
      // The loop stops after a model call that requested no tools.
      if (state.view._tag === "Root" && state.replied) {
        state.turn = endTurn(s, state.turn, "completed")
        state.replied = false
      }
      return
    case "assistant.message":
      assistantMessage(state, record.data, s, index, record.id ?? undefined, record.timestamp ?? undefined)
      return
    case "assistant.reasoning":
      if (record.data.content.trim().length > 0) {
        s.event({ type: "agent.reasoning", certainty: "known", content: record.data.content, representation: "provider_exposed" })
        state.lastReasoning = record.data.content
      }
      return
    case "abort":
      notice(s, "interruption", record.data.reason ?? "aborted")
      state.turn = endTurn(s, state.turn, "interrupted")
      state.replied = false
      return
    case "tool.execution_start":
      startCall(state, s, record.data)
      return
    case "tool.execution_complete":
      finishCall(state, s, record.data)
      return
    case "skill.invoked":
      if (record.data.content != null && record.data.content.length > 0) notice(s, "injected_context", record.data.content)
      return
    case "system.notification":
      notice(s, "task_notification", record.data.content)
      return
    case "hook.end":
      if (!record.data.success) {
        const error = record.data.error
        const detail = typeof error === "string" ? error : stringProp(error, "message")
        notice(s, "hook", detail ?? (record.data.hookType != null ? `Hook ${record.data.hookType} failed` : "Hook failed"))
      }
      return
    case "subagent.started": {
      // The subagent's own run: its prompt is the `task` call's prompt in the parent.
      const { data } = record
      if (data.model != null) s.metadata({ metadata: { model: data.model } })
      state.turn = startTurn(s, state.turn, subagentIdOf(record))
      const prompt = state.taskPrompts.get(data.toolCallId)
      if (prompt !== undefined && prompt.trim().length > 0) {
        s.event({ type: "user.message", certainty: "known", content: [{ type: "text", text: prompt }] })
        if (!state.sawPrompt) {
          s.metadata({ title: { value: titleFrom(prompt), priority: 10 } })
          state.sawPrompt = true
        }
      }
      return
    }
    case "subagent.completed":
      state.turn = endTurn(s, state.turn, record.data.cancelled === true ? "interrupted" : "completed")
      return
    case "subagent.failed":
      notice(s, "error", record.data.error ?? "Subagent failed")
      state.turn = endTurn(s, state.turn, "failed")
      return
  }
}

// ---------------------------------------------------------------------------
// Assistant messages
// ---------------------------------------------------------------------------

const assistantMessage = (
  state: CopilotState,
  data: AssistantMessageData,
  s: RecordScope,
  index: number,
  nativeId: string | undefined,
  timestamp: string | undefined
) => {
  // Reasoning is persisted on the message; `assistant.reasoning` (ephemeral in current
  // releases) repeats the same text when it is present, so it is read once.
  const reasoning = data.reasoningText
  if (reasoning != null && reasoning.trim().length > 0 && reasoning !== state.lastReasoning) {
    s.event({ type: "agent.reasoning", certainty: "known", content: reasoning, representation: "provider_exposed" })
  }
  state.lastReasoning = undefined

  const requests = data.toolRequests ?? []
  for (const request of requests) {
    if (!state.calls.has(request.toolCallId)) state.requests.set(request.toolCallId, request)
  }

  // `assistant.usage` is never persisted; the message carries the call's output tokens.
  // All chunks of one model call share `apiCallId`, so the call is counted once.
  const output = tokenCount(data.outputTokens)
  const call = data.apiCallId ?? undefined
  if (output !== undefined && (call === undefined || call !== state.lastUsageCall)) {
    s.event({ type: "usage.recorded", certainty: "known", ...usageFields({ model: data.model ?? state.model, outputTokens: output }) })
  }
  if (call !== undefined) state.lastUsageCall = call

  const text = data.content ?? ""
  const chunked = data.chunkCount != null && data.chunkCount > 1 && data.chunkIndex != null
  if (!chunked) {
    if (text.trim().length > 0) s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text }] })
    if (requests.length === 0 && text.trim().length > 0) state.replied = true
    return
  }
  // A response split at reasoning boundaries is one reply: coalesce its chunks.
  const key = chunkKey(data)
  let pending = state.chunks
  if (pending === undefined) {
    pending = { key, texts: [], requested: false, index, nativeId, timestamp }
    state.chunks = pending
  }
  if (text.trim().length > 0) pending.texts.push(text)
  pending.requested ||= requests.length > 0
  pending.index = index
  pending.nativeId = nativeId
  pending.timestamp = timestamp
  if (data.chunkIndex === data.chunkCount! - 1) {
    state.chunks = undefined
    emitReply(state, s, pending)
  }
}

const chunkKey = (data: AssistantMessageData) => data.apiCallId ?? data.messageId ?? ""

const emitReply = (state: CopilotState, s: RecordScope, pending: PendingChunks) => {
  if (pending.texts.length === 0) return
  s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: pending.texts.join("\n\n") }] })
  if (!pending.requested) state.replied = true
}

/** Emit the reply of a chunk series that never reached its last chunk. */
const flushChunks = (state: CopilotState): ReadonlyArray<Emission> => {
  const pending = state.chunks
  if (pending === undefined) return []
  state.chunks = undefined
  const s = scopeFor(state, pending.index, pending.nativeId, pending.timestamp)
  emitReply(state, s, pending)
  return s.emissions
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const startCall = (
  state: CopilotState,
  s: RecordScope,
  data: Pick<ToolStartData, "toolCallId" | "toolName" | "arguments">
): OpenCall | undefined => {
  // A resumed session re-announces tool calls left in flight; the first start is the fact.
  if (state.calls.has(data.toolCallId)) return state.calls.get(data.toolCallId)
  state.requests.delete(data.toolCallId)
  const input = data.arguments ?? undefined
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: data.toolCallId as ToolCallId,
    name: data.toolName,
    kind: toolKind(data.toolName, input),
    ...(input !== undefined ? { input: asJson(input) } : {})
  })
  if (data.toolName === TASK_TOOL) state.ownTasks.add(data.toolCallId)
  let commandStartedId: EventId | undefined
  const command = SHELL_TOOLS.has(data.toolName) ? stringProp(input, "command") : undefined
  if (command !== undefined) {
    commandStartedId = s.event({
      type: "command.started",
      certainty: "known",
      commandId: data.toolCallId as CommandId,
      command,
      shell: data.toolName,
      ...(state.cwd !== undefined ? { cwd: state.cwd } : {}),
      parentEventId: startedId,
      derivedFrom: [startedId]
    })
  }
  const call: OpenCall = {
    startedId,
    name: data.toolName,
    input,
    commandStartedId,
    background: stringProp(input, "mode") === "async" || (typeof input === "object" && input !== null && (input as Record<string, unknown>)["detach"] === true)
  }
  state.calls.set(data.toolCallId, call)
  return call
}

const outcomeOf = (exitCode: number): CommandOutcome => (exitCode === 0 ? "succeeded" : "failed")

const finishCall = (state: CopilotState, s: RecordScope, data: ToolCompleteData) => {
  let call = state.calls.get(data.toolCallId)
  if (call === undefined) {
    // Older logs may lack the start; the request in the assistant message names the call.
    const request = state.requests.get(data.toolCallId)
    if (request === undefined) {
      s.warning("orphan_tool_result", "Tool results without a matching tool call")
      return
    }
    call = startCall(state, s, { toolCallId: request.toolCallId, toolName: request.name, arguments: request.arguments })!
  }
  state.calls.delete(data.toolCallId)
  const toolCallId = data.toolCallId as ToolCallId
  const text = data.result?.content ?? data.result?.detailedContent ?? ""
  const errorMessage = typeof data.error === "string" ? data.error : data.error?.message ?? undefined
  const resultId = data.success
    ? s.event({ type: "tool.completed", certainty: "known", toolCallId, output: text })
    : s.event({ type: "tool.failed", certainty: "known", toolCallId, message: errorMessage ?? (text.length > 0 ? text : "Tool call failed") })
  const link = { parentEventId: call.startedId, derivedFrom: [call.startedId, resultId] }

  if (call.commandStartedId !== undefined) {
    const exitCode = exitCodeOf(data)
    // A command started in the background is still running when its tool call returns.
    if (exitCode !== undefined || !data.success || !call.background) {
      const stdout = text.replace(EXIT_TRAILER, "")
      s.event({
        type: "command.completed",
        certainty: "known",
        commandId: data.toolCallId as CommandId,
        outcome: exitCode !== undefined ? outcomeOf(exitCode) : data.success ? "unknown" : "failed",
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(stdout.length > 0 ? { stdout } : {}),
        ...link
      })
    }
  }

  if (!data.success) return
  const known = { certainty: "known" as const, ...link }

  if (data.fileEdits != null && data.fileEdits.length > 0) {
    for (const edit of data.fileEdits) {
      if (edit.kind === "create") s.event({ type: "file.created", path: edit.path, ...known })
      else if (edit.kind === "delete") s.event({ type: "file.deleted", path: edit.path, ...known })
      else s.event({ type: "file.changed", path: edit.path, ...known })
    }
    return
  }

  const path = stringProp(call.input, "path")
  switch (call.name) {
    case "view":
      if (path !== undefined) s.event({ type: "file.read", path, ...known })
      break
    case "create":
      if (path !== undefined) s.event({ type: "file.created", path, ...known })
      break
    case "edit":
    case "str_replace":
    case "insert":
      if (path !== undefined) s.event({ type: "file.changed", path, ...known })
      break
    case "str_replace_editor": {
      const command = stringProp(call.input, "command")
      if (path === undefined) break
      if (command === "view") s.event({ type: "file.read", path, ...known })
      else if (command === "create") s.event({ type: "file.created", path, ...known })
      else if (command === "str_replace" || command === "insert") s.event({ type: "file.changed", path, ...known })
      break
    }
    case "apply_patch": {
      const patch = typeof call.input === "string" ? call.input : stringProp(call.input, "input", "patch")
      for (const header of patchHeaders(patch ?? "")) {
        if (header.change === "created") s.event({ type: "file.created", path: header.path, ...known })
        else if (header.change === "deleted") s.event({ type: "file.deleted", path: header.path, ...known })
        else s.event({ type: "file.changed", path: header.path, ...known })
      }
      break
    }
    case "update_todo": {
      const todos = stringProp(call.input, "todos")
      const entries = todos === undefined ? [] : todoEntries(todos)
      if (entries.length > 0) emitPlan(s, entries, "content", known)
      break
    }
  }
}
