import { type Emission, parseJson, RecordScope, type SourceLine, stringProp, titleFrom } from "@agentbridge/core"
import type { CommandId, EventId, SessionId, ToolCallId, ToolKind } from "@agentbridge/schema"
import { Option, Schema } from "effect"
import { AntigravityStep, type AntigravityToolCall } from "./schema/AntigravityRecord.ts"

export const HARNESS = "antigravity"
export const NAME = "Antigravity"
export const FORMAT = "antigravity-transcript-jsonl"

const TOOL_KINDS: Record<string, ToolKind> = {
  view_file: "read",
  view_file_outline: "read",
  view_code_item: "read",
  write_to_file: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  run_command: "execute",
  command_status: "execute",
  grep_search: "search",
  find_by_name: "search",
  list_dir: "search",
  codebase_search: "search",
  search_web: "search",
  read_url_content: "fetch"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name.toLowerCase()] ?? "other"

/** Step types that replay earlier turns or track bookkeeping. */
const IGNORED_STEPS = new Set(["CONVERSATION_HISTORY", "CHECKPOINT", "EPHEMERAL_MESSAGE"])

/** Step types whose tool output name differs from the tool call name. */
const STEP_TOOL_ALIASES: Record<string, ReadonlyArray<string>> = {
  LIST_DIRECTORY: ["list_dir"],
  CODE_ACTION: ["write_to_file", "replace_file_content", "multi_replace_file_content"],
  FILE_CHANGE: ["write_to_file", "replace_file_content", "multi_replace_file_content"]
}

const FAILED_STATUSES = new Set(["ERROR", "FAILED", "CANCELED", "CANCELLED"])

const decodeStep = Schema.decodeUnknownOption(AntigravityStep)

export type DecodedStep =
  | { readonly _tag: "Step"; readonly index: number; readonly step: AntigravityStep }
  | { readonly _tag: "Skip"; readonly index: number }
  | { readonly _tag: "Malformed"; readonly index: number; readonly reason: "json" | "schema" }

export const decodeLine = ({ index, line }: SourceLine): DecodedStep => {
  if (line.trim().length === 0) return { _tag: "Skip", index }
  const json = parseJson(line)
  if (Option.isNone(json)) return { _tag: "Malformed", index, reason: "json" }
  return Option.match(decodeStep(json.value), {
    onNone: () => ({ _tag: "Malformed", index, reason: "schema" }),
    onSome: (step) => ({ _tag: "Step", index, step })
  })
}

/** `<USER_REQUEST>…</USER_REQUEST>` holds what the user typed; anything around it is harness context. */
export const splitUserInput = (content: string) => {
  const request = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)
  if (!request) return { prompt: content.trim(), context: "" }
  return { prompt: request[1]!.trim(), context: content.replace(request[0], "").trim() }
}

interface OpenCall {
  readonly name: string
  readonly toolCallId: ToolCallId
  readonly startedId: EventId
  readonly args: unknown
  readonly commandStartedId?: EventId
}

export interface AntigravityState {
  readonly sessionId: SessionId
  readonly path: string
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly projectPath: string | undefined
  /** Planner tool calls still waiting for an output step, oldest first. */
  readonly open: ReadonlyArray<OpenCall>
}

export const initialState = (sessionId: SessionId, path: string): AntigravityState => ({
  sessionId,
  path,
  started: false,
  sawPrompt: false,
  projectPath: undefined,
  open: []
})

const asJson = (value: unknown) => value as Schema.Json

type Step = readonly [AntigravityState, ReadonlyArray<Emission>]

export const normalizeLine = (initial: AntigravityState, line: DecodedStep): Step => {
  let state = initial
  if (line._tag === "Skip") return [state, []]
  const base = { harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.path, recordIndex: line.index }
  if (line._tag === "Malformed") {
    const s = new RecordScope(base)
    s.warning(line.reason === "json" ? "malformed_json" : "malformed_record", line.reason === "json"
      ? "Skipped lines that are not valid JSON"
      : "Skipped steps that do not match the expected step shape")
    return [state, s.emissions]
  }
  const { step } = line
  const type = step.type ?? (step.source === "USER_EXPLICIT" ? "USER_INPUT" : step.source === "MODEL" ? "PLANNER_RESPONSE" : "")
  if (IGNORED_STEPS.has(type)) return [state, []]
  const s = new RecordScope({
    ...base,
    nativeEventId: step.step_index === undefined ? undefined : String(step.step_index),
    timestamp: step.created_at
  })
  if (type === "") {
    s.warning("unknown_record_type", "Ignored Antigravity steps without a type")
    return [state, s.emissions]
  }
  if (!state.started) {
    s.event({ type: "session.started", certainty: "known" })
    state = { ...state, started: true }
  }
  const content = step.content ?? ""

  switch (type) {
    case "USER_INPUT": {
      const { context, prompt } = splitUserInput(content)
      if (context.length > 0) {
        s.event({ type: "harness.notice", certainty: "known", kind: "injected_context", content: [{ type: "text", text: context }] })
      }
      if (prompt.length > 0) {
        s.event({ type: "user.message", certainty: "known", content: [{ type: "text", text: prompt }] })
        if (!state.sawPrompt) {
          s.metadata({ title: { value: titleFrom(prompt), priority: 10 } })
          state = { ...state, sawPrompt: true }
        }
      }
      return [state, s.emissions]
    }
    case "PLANNER_RESPONSE": {
      if (content.trim().length > 0) {
        s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: content }] })
      }
      for (const call of step.tool_calls ?? []) state = startCall(state, s, call)
      return [state, s.emissions]
    }
    default:
      return [completeCall(state, s, type, step.status, content), s.emissions]
  }
}

const startCall = (initial: AntigravityState, s: RecordScope, call: AntigravityToolCall): AntigravityState => {
  let state = initial
  const toolCallId = s.nextId("tool.started") as string as ToolCallId
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId,
    name: call.name,
    kind: toolKind(call.name),
    ...(call.args !== undefined ? { input: asJson(call.args) } : {})
  })
  const cwd = stringProp(call.args, "Cwd", "cwd")
  if (cwd !== undefined && state.projectPath === undefined) {
    s.metadata({ projectPath: cwd })
    state = { ...state, projectPath: cwd }
  }
  const command = call.name === "run_command" ? stringProp(call.args, "CommandLine", "command") : undefined
  const commandStartedId = command === undefined ? undefined : s.event({
    type: "command.started",
    certainty: "known",
    commandId: toolCallId as string as CommandId,
    command,
    ...(cwd !== undefined ? { cwd } : {}),
    parentEventId: startedId,
    derivedFrom: [startedId]
  })
  const open: OpenCall = {
    name: call.name,
    toolCallId,
    startedId,
    args: call.args,
    ...(commandStartedId !== undefined ? { commandStartedId } : {})
  }
  return { ...state, open: [...state.open, open] }
}

/**
 * A tool step completes the oldest open call with a matching name, else the oldest
 * open call. The pairing is by order rather than by ID, so completions are `inferred`.
 */
const completeCall = (state: AntigravityState, s: RecordScope, stepType: string, status: string | undefined, content: string): AntigravityState => {
  const names = new Set([stepType.toLowerCase(), ...(STEP_TOOL_ALIASES[stepType] ?? [])])
  let index = state.open.findIndex((call) => names.has(call.name.toLowerCase()))
  if (index < 0) index = state.open.length > 0 ? 0 : -1
  if (index < 0) {
    s.warning("orphan_tool_result", "Tool output steps without a matching tool call")
    return state
  }
  const call = state.open[index]!
  const failed = status !== undefined && FAILED_STATUSES.has(status.toUpperCase())
  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "inferred", toolCallId: call.toolCallId, message: content || status! })
    : s.event({ type: "tool.completed", certainty: "inferred", toolCallId: call.toolCallId, output: content })
  const link = { certainty: "inferred" as const, parentEventId: call.startedId, derivedFrom: [call.startedId, resultId] }

  if (call.commandStartedId !== undefined) {
    const exit = /exit(?:ed with)? code:? (-?\d+)/i.exec(content)?.[1]
    s.event({
      type: "command.completed",
      commandId: call.toolCallId as string as CommandId,
      outcome: exit !== undefined ? (exit === "0" ? "succeeded" : "failed") : failed ? "failed" : "unknown",
      ...(exit !== undefined ? { exitCode: Number(exit) } : {}),
      stdout: content,
      ...link
    })
  }
  if (!failed) {
    const path = stringProp(call.args, "AbsolutePath", "TargetFile", "file_path", "path")
    if (path !== undefined) {
      if (toolKind(call.name) === "read") s.event({ type: "file.read", path, ...link })
      else if (toolKind(call.name) === "edit") s.event({ type: "file.changed", path, ...link })
    }
  }
  return { ...state, open: state.open.filter((_, i) => i !== index) }
}
