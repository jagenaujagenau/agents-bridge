import {
  type Emission,
  emitPlan,
  parseJson,
  planList,
  RecordScope,
  tokenCount,
  usageFields
} from "@agentbridge/core"
import {
  type CommandId,
  type CommandOutcome,
  type ContentBlock,
  type EventId,
  makeSessionId,
  type NoticeKind,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import { Option, Schema } from "effect"
import type { DecodedLine } from "./CodexSource.ts"
import {
  type EventMsg,
  type ExecCommandEnd,
  ObjectOutput,
  ParsedRead,
  type PatchApplyEnd,
  type ResponseItem,
  StructuredOutput
} from "./schema/CodexRecord.ts"

export const HARNESS = "codex"
export const FORMAT = "codex-rollout-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native Codex tool names are interpreted)
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  exec_command: "execute",
  shell: "execute",
  shell_command: "execute",
  local_shell: "execute",
  container_exec: "execute",
  write_stdin: "execute",
  apply_patch: "edit",
  web_search: "search",
  tool_search: "search",
  view_image: "read",
  update_plan: "think"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenCall {
  readonly startedId: EventId
  readonly name: string
  readonly commandStartedId?: EventId
  readonly patch?: string
  readonly plan?: unknown
}

interface PendingCommand {
  readonly startedId: EventId
  readonly commandStartedId: EventId
  readonly resultId: EventId
}

export interface CodexState {
  readonly sessionId: SessionId
  readonly path: string
  readonly metaSeen: boolean
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly cwd: string | undefined
  readonly calls: ReadonlyMap<string, OpenCall>
  /** `exec_command_end` / `patch_apply_end` that arrived before the tool output. */
  readonly execEnds: ReadonlyMap<string, ExecCommandEnd>
  readonly patchEnds: ReadonlyMap<string, PatchApplyEnd>
  /** Commands whose tool output arrived while the process was still running. */
  readonly pending: ReadonlyMap<string, PendingCommand>
  readonly turn: string | undefined
  readonly model: string | undefined
  /** Cumulative total of the last token_count; repeated counts (rate-limit refreshes) carry no new usage. */
  readonly usageTotal: number | undefined
}

export const initialState = (sessionId: SessionId, path: string): CodexState => ({
  sessionId,
  path,
  metaSeen: false,
  started: false,
  sawPrompt: false,
  cwd: undefined,
  calls: new Map(),
  execEnds: new Map(),
  patchEnds: new Map(),
  pending: new Map(),
  turn: undefined,
  model: undefined,
  usageTotal: undefined
})

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V) => new Map(map).set(key, value)
const without = <V>(map: ReadonlyMap<string, V>, key: string) => {
  const next = new Map(map)
  next.delete(key)
  return next
}

// ---------------------------------------------------------------------------
// Text classification
// ---------------------------------------------------------------------------

const NOTICE_PREFIXES: ReadonlyArray<readonly [string, NoticeKind]> = [
  ["<environment_context", "injected_context"],
  ["# AGENTS.md instructions", "injected_context"],
  ["<user_instructions", "injected_context"],
  ["<goal_context", "injected_context"],
  ["<codex_internal_context", "injected_context"],
  ["<permissions instructions", "injected_context"],
  ["The following is the Codex agent history", "injected_context"],
  ["<hook_prompt", "hook"],
  ["<turn_aborted", "interruption"],
  ["<user_shell_command", "command_output"]
]

/** Clients (IDE, in-app browser) prepend `# <context>` sections and mark the real prompt with this heading. */
const REQUEST_MARKER = "## My request for Codex:"

export const classifyUserText = (
  text: string
): { readonly _tag: "Prompt"; readonly text: string } | { readonly _tag: "Notice"; readonly kind: NoticeKind } => {
  const trimmed = text.trimStart()
  for (const [prefix, kind] of NOTICE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return { _tag: "Notice", kind }
  }
  if (trimmed.startsWith("# ")) {
    const request = trimmed.indexOf(REQUEST_MARKER)
    if (request !== -1) return { _tag: "Prompt", text: trimmed.slice(request + REQUEST_MARKER.length).trim() }
    if (trimmed.startsWith("# Context from my IDE setup:")) return { _tag: "Notice", kind: "injected_context" }
  }
  return { _tag: "Prompt", text }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decodeStructuredOutput = Schema.decodeUnknownOption(StructuredOutput)
const decodeObjectOutput = Schema.decodeUnknownOption(ObjectOutput)
const decodeParsedRead = Schema.decodeUnknownOption(ParsedRead)

interface ToolOutput {
  readonly text: string
  readonly exitCode: number | undefined
  readonly success: boolean | undefined
}

/** Interpret the several historical encodings of a tool output. */
const readOutput = (raw: unknown): ToolOutput => {
  if (typeof raw === "string") {
    const structured = raw.trimStart().startsWith("{")
      ? Option.flatMap(parseJson(raw), decodeStructuredOutput)
      : Option.none()
    if (Option.isSome(structured) && structured.value.output !== undefined) {
      return { text: structured.value.output, exitCode: structured.value.metadata?.exit_code, success: undefined }
    }
    const header = /^Process exited with code (-?\d+)$/m.exec(raw)
    const body = /\nOutput:\n([\s\S]*)$/.exec(raw)
    return { text: body?.[1] ?? raw, exitCode: header ? Number(header[1]) : undefined, success: undefined }
  }
  const object = decodeObjectOutput(raw)
  if (Option.isSome(object)) {
    return { text: object.value.content ?? "", exitCode: undefined, success: object.value.success ?? undefined }
  }
  return { text: raw === undefined ? "" : JSON.stringify(raw), exitCode: undefined, success: undefined }
}

const parseArguments = (raw: string | undefined): unknown =>
  raw === undefined ? undefined : Option.getOrElse(parseJson(raw), () => raw)

const commandOf = (name: string, args: unknown): { command: string; cwd: string | undefined } | undefined => {
  if (typeof args !== "object" || args === null) return undefined
  const record = args as Record<string, unknown>
  const cwd = typeof record["workdir"] === "string" ? record["workdir"] : undefined
  const join = (value: unknown) =>
    typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join(" ") : undefined
  const command = name === "exec_command" ? join(record["cmd"]) : name.startsWith("shell") || name === "container_exec"
    ? join(record["command"])
    : undefined
  return command === undefined ? undefined : { command, cwd }
}

/** `*** Add File: path` headers from an apply_patch body, used only when `patch_apply_end` is absent. */
const patchHeaders = (patch: string) =>
  [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((match) => ({
    type: match[1] === "Add" ? "add" : match[1] === "Delete" ? "delete" : "update",
    path: match[2]!.trim()
  }))

const asJson = (value: unknown) => value as Schema.Json

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [CodexState, ReadonlyArray<Emission>]

export const normalizeLine = (state: CodexState, line: DecodedLine): Step => {
  // Rollouts have no native event IDs; IDs anchor on the line index (§33 fallback).
  const s = new RecordScope({
    harness: HARNESS,
    sessionId: state.sessionId,
    format: FORMAT,
    path: state.path,
    recordIndex: line.index,
    timestamp: line.timestamp
  })

  switch (line._tag) {
    case "Ignored":
      return [state, []]
    case "Malformed":
      s.warning(
        line.reason === "json" ? "malformed_json" : "malformed_record",
        line.reason === "json"
          ? "Skipped lines that are not valid JSON"
          : `Skipped records that do not match the expected ${line.nativeType ?? "rollout line"} shape`
      )
      return [state, s.emissions]
    case "Unknown":
      s.warning("unknown_record_type", `Ignored unknown Codex record type "${line.nativeType}"`)
      return [state, s.emissions]
    case "SessionMeta": {
      // A forked or resumed rollout repeats session_meta with the parent's id: bind only the first.
      if (state.metaSeen) return [state, []]
      const { meta } = line
      s.metadata({
        ...(meta.cwd !== undefined ? { projectPath: meta.cwd } : {}),
        ...(meta.cli_version !== undefined ? { harnessVersion: meta.cli_version } : {}),
        ...(meta.timestamp !== undefined ? { startedAt: meta.timestamp } : {}),
        metadata: {
          ...(meta.originator !== undefined ? { originator: meta.originator } : {}),
          ...(meta.model_provider !== undefined ? { modelProvider: meta.model_provider } : {}),
          ...(meta.git?.branch ? { gitBranch: meta.git.branch } : {}),
          ...(meta.git?.commit_hash ? { gitCommit: meta.git.commit_hash } : {}),
        },
        ...(meta.forked_from_id
          ? { relationships: [{ type: "fork", from: state.sessionId, to: makeSessionId(HARNESS, meta.forked_from_id) }] }
          : {})
      })
      s.event({ type: "session.started", certainty: "known" })
      return [{ ...state, metaSeen: true, started: true, cwd: meta.cwd ?? state.cwd }, s.emissions]
    }
    case "TurnContext": {
      if (line.context.model !== undefined) s.metadata({ metadata: { model: line.context.model } })
      return [{ ...state, cwd: line.context.cwd ?? state.cwd, model: line.context.model ?? state.model }, s.emissions]
    }
    case "Compacted":
      s.event({
        type: "context.compacted",
        certainty: "known",
        ...(line.compacted.message ? { summary: line.compacted.message } : {})
      })
      return [state, s.emissions]
    case "Event":
      return normalizeEvent(state, line.event, s)
    case "ResponseItem":
      return normalizeItem(state, line.item, s)
  }
}

const normalizeItem = (state: CodexState, item: ResponseItem, s: RecordScope): Step => {
  switch (item.type) {
    case "message":
      return normalizeMessage(state, item, s)
    case "reasoning": {
      // Encrypted reasoning with an empty summary emits nothing: never reconstruct hidden reasoning.
      const summary = (item.summary ?? []).flatMap((part) => (part.text ? [part.text] : [])).join("\n\n")
      if (summary.length > 0) {
        s.event({ type: "agent.reasoning", certainty: "known", content: summary, representation: "summary" })
      }
      const exposed = (item.content ?? []).flatMap((part) => (part.text ? [part.text] : [])).join("\n\n")
      if (exposed.length > 0) {
        s.event({ type: "agent.reasoning", certainty: "known", content: exposed, representation: "provider_exposed" })
      }
      return [state, s.emissions]
    }
    case "function_call": {
      const input = parseArguments(item.arguments)
      return startCall(state, s, item.call_id, item.name, input, commandOf(item.name, input))
    }
    case "custom_tool_call":
      return startCall(state, s, item.call_id, item.name, item.input, undefined, item.name === "apply_patch" ? item.input : undefined)
    case "local_shell_call": {
      const callId = item.call_id ?? item.id ?? s.nextId("tool.started")
      const command = { command: item.action.command.join(" "), cwd: item.action.working_directory ?? undefined }
      return startCall(state, s, callId, "local_shell", asJson(item.action), command)
    }
    case "web_search_call": {
      const toolCallId = s.nextId("tool.started") as string as ToolCallId
      const query = item.action?.query ?? undefined
      const startedId = s.event({
        type: "tool.started",
        certainty: "known",
        toolCallId,
        name: "web_search",
        kind: "search",
        ...(query !== undefined ? { input: { query } } : {})
      })
      s.event({ type: "tool.completed", certainty: "known", toolCallId, parentEventId: startedId })
      return [state, s.emissions]
    }
    case "tool_search_call":
      return startCall(state, s, item.call_id, "tool_search", item.arguments, undefined)
    case "tool_search_output":
      return finishCall(state, s, item.call_id, { text: "", exitCode: undefined, success: undefined })
    case "function_call_output":
    case "custom_tool_call_output":
      return finishCall(state, s, item.call_id, readOutput(item.output))
  }
}

const normalizeMessage = (
  initial: CodexState,
  item: Extract<ResponseItem, { type: "message" }>,
  s: RecordScope
): Step => {
  let state = initial
  const content: Array<ContentBlock> = []
  for (const part of item.content) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue
    const record = part as Record<string, unknown>
    if ((record["type"] === "input_text" || record["type"] === "output_text") && typeof record["text"] === "string") {
      content.push({ type: "text", text: record["text"] })
    }
    if (record["type"] === "input_image" && typeof record["image_url"] === "string") {
      content.push({ type: "image", uri: record["image_url"] })
    }
  }
  if (content.length === 0) return [state, s.emissions]

  if (item.role === "assistant") {
    s.event({ type: "agent.message", certainty: "known", content })
  } else if (item.role === "user") {
    // Codex sends each injected context block as its own text part; classify per part.
    const prompt: Array<ContentBlock> = []
    for (const block of content) {
      const classified = block.type === "text" ? classifyUserText(block.text) : undefined
      if (classified?._tag === "Notice") {
        s.event({ type: "harness.notice", certainty: "known", kind: classified.kind, content: [block] })
      } else if (classified?._tag === "Prompt") {
        prompt.push({ type: "text", text: classified.text })
      } else {
        prompt.push(block)
      }
    }
    if (prompt.length > 0) {
      s.event({ type: "user.message", certainty: "known", content: prompt })
      const first = prompt.find((b) => b.type === "text")
      if (!state.sawPrompt && first?.type === "text") {
        s.metadata({ title: { value: firstLine(first.text), priority: 10 } })
        state = { ...state, sawPrompt: true }
      }
    }
  }
  // developer / system messages are harness configuration, not conversation.
  return [state, s.emissions]
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

const startCall = (
  state: CodexState,
  s: RecordScope,
  callId: string,
  name: string,
  input: unknown,
  command: { readonly command: string; readonly cwd: string | undefined } | undefined,
  patch?: string
): Step => {
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: callId as ToolCallId,
    name,
    kind: toolKind(name),
    ...(input !== undefined ? { input: asJson(input) } : {})
  })
  let commandStartedId: EventId | undefined
  if (command !== undefined) {
    const cwd = command.cwd ?? state.cwd
    commandStartedId = s.event({
      type: "command.started",
      certainty: "known",
      commandId: callId as CommandId,
      command: command.command,
      ...(cwd !== undefined ? { cwd } : {}),
      parentEventId: startedId,
      derivedFrom: [startedId]
    })
  }
  const call: OpenCall = {
    startedId,
    name,
    ...(name === "update_plan" ? { plan: planList(input, "plan") } : {}),
    ...(commandStartedId !== undefined ? { commandStartedId } : {}),
    ...(patch !== undefined ? { patch } : {})
  }
  return [{ ...state, calls: withEntry(state.calls, callId, call) }, s.emissions]
}

const outcomeOf = (exitCode: number | undefined): CommandOutcome =>
  exitCode === undefined ? "unknown" : exitCode === 0 ? "succeeded" : "failed"

const finishCall = (initial: CodexState, s: RecordScope, callId: string, output: ToolOutput): Step => {
  let state = initial
  const call = state.calls.get(callId)
  const toolCallId = callId as ToolCallId
  const execEnd = state.execEnds.get(callId)
  const patchEnd = state.patchEnds.get(callId)
  const exitCode = execEnd?.exit_code ?? output.exitCode

  const failed = patchEnd !== undefined
    ? !patchEnd.success
    : output.success === false || (exitCode !== undefined && exitCode !== 0) ||
      (call?.patch !== undefined && output.exitCode === undefined && /verification failed/i.test(output.text))

  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: output.text })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId, output: output.text })

  if (call === undefined) {
    s.warning("orphan_tool_result", "Tool results without a matching tool call")
    return [state, s.emissions]
  }
  state = {
    ...state,
    calls: without(state.calls, callId),
    execEnds: without(state.execEnds, callId),
    patchEnds: without(state.patchEnds, callId)
  }

  if (call.commandStartedId !== undefined) {
    if (execEnd !== undefined) {
      completeCommand(s, callId, call.startedId, call.commandStartedId, [call.startedId, resultId], execEnd)
    } else if (output.exitCode !== undefined) {
      s.event({
        type: "command.completed",
        certainty: "known",
        commandId: callId as CommandId,
        outcome: outcomeOf(output.exitCode),
        exitCode: output.exitCode,
        stdout: output.text,
        parentEventId: call.startedId,
        derivedFrom: [call.startedId, resultId]
      })
    } else {
      // Still running (long-lived exec session); exec_command_end will complete it.
      state = {
        ...state,
        pending: withEntry(state.pending, callId, {
          startedId: call.startedId,
          commandStartedId: call.commandStartedId,
          resultId
        })
      }
    }
  }

  if (call.name === "update_plan" && !failed) {
    emitPlan(s, call.plan, "step", { certainty: "known", parentEventId: call.startedId, derivedFrom: [call.startedId, resultId] })
  }

  if (call.patch !== undefined && !failed) {
    const link = { parentEventId: call.startedId, derivedFrom: [call.startedId, resultId] }
    const changes = patchEnd?.changes
    if (changes !== undefined) {
      for (const [path, change] of Object.entries(changes)) {
        const diff = change.unified_diff ? { diff: change.unified_diff } : {}
        if (change.type === "add") s.event({ type: "file.created", certainty: "known", path, ...diff, ...link })
        else if (change.type === "delete") s.event({ type: "file.deleted", certainty: "known", path, ...link })
        else {
          s.event({
            type: "file.changed",
            certainty: "known",
            path: change.move_path ?? path,
            ...(change.move_path ? { previousPath: path } : {}),
            ...diff,
            ...link
          })
        }
      }
    } else {
      for (const header of patchHeaders(call.patch)) {
        const base = { certainty: "known" as const, path: header.path, ...link }
        if (header.type === "add") s.event({ type: "file.created", ...base })
        else if (header.type === "delete") s.event({ type: "file.deleted", ...base })
        else s.event({ type: "file.changed", ...base })
      }
    }
  }
  return [state, s.emissions]
}

const completeCommand = (
  s: RecordScope,
  callId: string,
  startedId: EventId,
  commandStartedId: EventId,
  derivedFrom: Array<EventId>,
  end: ExecCommandEnd
) => {
  const outcome = outcomeOf(end.exit_code)
  const stdout = end.aggregated_output ?? end.stdout
  const durationMs = end.duration ? Math.round(end.duration.secs * 1000 + end.duration.nanos / 1e6) : undefined
  s.event({
    type: "command.completed",
    certainty: "known",
    commandId: callId as CommandId,
    outcome,
    exitCode: end.exit_code,
    ...(stdout !== undefined ? { stdout } : {}),
    ...(end.stderr ? { stderr: end.stderr } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    parentEventId: startedId,
    derivedFrom
  })
  if (outcome !== "succeeded") return
  // Codex's own command parser classified these as reads; Bridge did not observe the read itself.
  for (const parsed of end.parsed_cmd ?? []) {
    const read = Option.getOrUndefined(decodeParsedRead(parsed))
    const path = read?.path ?? read?.name
    if (path) {
      s.event({
        type: "file.read",
        certainty: "inferred",
        path,
        parentEventId: commandStartedId,
        derivedFrom: [commandStartedId]
      })
    }
  }
}

const normalizeEvent = (state: CodexState, event: EventMsg, s: RecordScope): Step => {
  switch (event.type) {
    case "thread_name_updated":
      s.metadata({ title: { value: event.thread_name, priority: 30 } })
      return [state, s.emissions]
    case "exec_command_end": {
      const pending = state.pending.get(event.call_id)
      if (pending !== undefined) {
        completeCommand(
          s,
          event.call_id,
          pending.startedId,
          pending.commandStartedId,
          [pending.startedId, pending.resultId],
          event
        )
        return [{ ...state, pending: without(state.pending, event.call_id) }, s.emissions]
      }
      if (state.calls.has(event.call_id)) {
        return [{ ...state, execEnds: withEntry(state.execEnds, event.call_id, event) }, s.emissions]
      }
      // A shell command the user ran (`!cmd`): no tool call, so the end record is the whole fact.
      const argv = event.command ?? []
      const command = argv.length >= 3 && /^-l?c$/.test(argv[argv.length - 2]!) ? argv[argv.length - 1]! : argv.join(" ")
      if (command.length === 0) return [state, s.emissions]
      const commandStartedId = s.event({
        type: "command.started",
        certainty: "known",
        commandId: event.call_id as CommandId,
        command,
        ...(event.cwd ?? state.cwd ? { cwd: event.cwd ?? state.cwd! } : {})
      })
      completeCommand(s, event.call_id, commandStartedId, commandStartedId, [commandStartedId], event)
      return [state, s.emissions]
    }
    case "patch_apply_end":
      if (state.calls.has(event.call_id)) {
        return [{ ...state, patchEnds: withEntry(state.patchEnds, event.call_id, event) }, s.emissions]
      }
      return [state, s.emissions]
    case "task_started": {
      let next = state
      if (next.turn !== undefined) {
        s.event({ type: "turn.completed", certainty: "inferred", turnId: next.turn, outcome: "unknown" })
      }
      const turnId = event.turn_id ?? String(s.options.recordIndex)
      s.event({ type: "turn.started", certainty: "known", turnId })
      next = { ...next, turn: turnId }
      return [next, s.emissions]
    }
    case "task_complete":
    case "turn_aborted": {
      const turnId = state.turn
      if (turnId === undefined) return [state, s.emissions]
      s.event({
        type: "turn.completed",
        certainty: "known",
        turnId,
        outcome: event.type === "task_complete" ? "completed" : "interrupted",
        ...(event.duration_ms !== undefined ? { durationMs: event.duration_ms } : {})
      })
      return [{ ...state, turn: undefined }, s.emissions]
    }
    case "token_count": {
      const last = event.info?.last_token_usage
      const total = event.info?.total_token_usage?.total_tokens
      if (last === undefined || (total !== undefined && total === state.usageTotal)) return [state, s.emissions]
      const input = tokenCount(last.input_tokens)
      const cached = tokenCount(last.cached_input_tokens)
      // OpenAI counts cached tokens inside input_tokens; the canonical inputTokens excludes them.
      s.event({
        type: "usage.recorded",
        certainty: "known",
        ...usageFields({
          model: state.model,
          inputTokens: input !== undefined ? input - (cached ?? 0) : undefined,
          cacheReadTokens: cached,
          outputTokens: tokenCount(last.output_tokens),
          reasoningTokens: tokenCount(last.reasoning_output_tokens)
        })
      })
      return [{ ...state, usageTotal: total ?? state.usageTotal }, s.emissions]
    }
  }
}
