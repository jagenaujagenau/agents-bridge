import {
  type Emission,
  emitPlan,
  makeRecordDecoder,
  planList,
  RecordScope,
  stringProp,
  textOf,
  titleFrom,
  tokenCount,
  usageFields,
  warnUndecodable
} from "@agentbridge/core"
import type { CommandId, CommandOutcome, ContentBlock, EventId, SessionId, ToolCallId, ToolKind } from "@agentbridge/schema"
import { Option, Schema } from "effect"
import {
  FileDiffDisplay,
  type GeminiMessage,
  GeminiMessage as GeminiMessageSchema,
  type GeminiToolCall,
  KNOWN_MESSAGE_TYPES
} from "./schema/GeminiRecord.ts"

export const HARNESS = "gemini-cli"
export const NAME = "Gemini CLI"
export const FORMAT = "gemini-cli-chat-json"

const TOOL_KINDS: Record<string, ToolKind> = {
  read_file: "read",
  read_many_files: "read",
  write_file: "edit",
  replace: "edit",
  run_shell_command: "execute",
  glob: "search",
  search_file_content: "search",
  grep: "search",
  list_directory: "search",
  google_web_search: "search",
  web_fetch: "fetch",
  write_todos: "think",
  save_memory: "other"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

export const decodeMessage = makeRecordDecoder({ schema: GeminiMessageSchema, known: KNOWN_MESSAGE_TYPES, ignored: new Set() })

const decodeFileDiff = Schema.decodeUnknownOption(FileDiffDisplay)

const REFERENCED_FILES = /--- Content from referenced files ---[\s\S]*?--- End of content ---\n?/g

/** Text and function responses from a `content` value (string or parts). */
const partsOf = (content: unknown): ReadonlyArray<unknown> =>
  typeof content === "string" ? [{ text: content }] : Array.isArray(content) ? content : []

const isFunctionResponse = (part: unknown) => typeof part === "object" && part !== null && "functionResponse" in part

/** The model-facing output of a tool call: its first `functionResponse.response.output`. */
const decodeFunctionResponse = Schema.decodeUnknownOption(Schema.Struct({
  functionResponse: Schema.Struct({ response: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) })
}))

const functionOutput = (s: RecordScope, call: GeminiToolCall): string | undefined => {
  for (const part of call.result ?? []) {
    if (!isFunctionResponse(part)) continue
    const decoded = Option.getOrUndefined(decodeFunctionResponse(part))
    if (decoded === undefined) {
      s.warning("malformed_record", "Skipped malformed Gemini function responses")
      continue
    }
    const response = decoded.functionResponse.response
    const output = response?.["output"] ?? response?.["error"]
    if (typeof output === "string") return output
    if (output !== undefined) return JSON.stringify(output)
  }
  return typeof call.resultDisplay === "string" ? call.resultDisplay : undefined
}

/** Parse the `Exit Code:` line of `run_shell_command` output. */
export const shellStatus = (output: string | undefined, status: string | undefined): {
  readonly outcome: CommandOutcome
  readonly exitCode?: number
} => {
  if (status === "cancelled") return { outcome: "interrupted" }
  const exit = output === undefined ? undefined : /^Exit Code: (-?\d+)\s*$/m.exec(output)?.[1]
  if (exit !== undefined) return { outcome: exit === "0" ? "succeeded" : "failed", exitCode: Number(exit) }
  if (output !== undefined && /^Signal: (?!\(none\))/m.test(output)) return { outcome: "interrupted" }
  return { outcome: status === "error" ? "failed" : status === "success" ? "succeeded" : "unknown" }
}

const asJson = (value: unknown) => value as Schema.Json

export interface GeminiState {
  readonly sessionId: SessionId
  readonly path: string
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly projectPath: string | undefined
}

export const initialState = (sessionId: SessionId, path: string, projectPath: string | undefined): GeminiState => ({
  sessionId,
  path,
  started: false,
  sawPrompt: false,
  projectPath
})

type Step = readonly [GeminiState, ReadonlyArray<Emission>]

export const normalizeMessage = (initial: GeminiState, [raw, index]: readonly [unknown, number]): Step => {
  let state = initial
  const base = { harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.path, recordIndex: index }
  const decoded = decodeMessage(index, raw)
  if (decoded._tag === "Skip") return [state, []]
  if (decoded._tag !== "Record") {
    const s = new RecordScope(base)
    warnUndecodable(s, decoded, NAME)
    return [state, s.emissions]
  }
  const message: GeminiMessage = decoded.record
  const s = new RecordScope({ ...base, nativeEventId: message.id, timestamp: message.timestamp })
  if (!state.started) {
    s.event({ type: "session.started", certainty: "known" })
    state = { ...state, started: true }
  }

  switch (message.type) {
    case "user": {
      const parts = partsOf(message.content)
      // A turn made only of function responses echoes results the model turn already records.
      if (parts.length > 0 && parts.every(isFunctionResponse)) return [state, s.emissions]
      const text = textOf(parts).replace(REFERENCED_FILES, "").trim()
      if (text.length === 0) return [state, s.emissions]
      const content: Array<ContentBlock> = [{ type: "text", text }]
      s.event({ type: "user.message", certainty: "known", content })
      if (!state.sawPrompt) {
        s.metadata({ title: { value: titleFrom(text), priority: 10 } })
        state = { ...state, sawPrompt: true }
      }
      return [state, s.emissions]
    }
    case "info":
    case "warning":
    case "error": {
      const text = textOf(partsOf(message.content)).trim()
      if (text.length > 0) {
        s.event({
          type: "harness.notice",
          certainty: "known",
          kind: message.type === "error" ? "error" : "other",
          content: [{ type: "text", text }]
        })
      }
      return [state, s.emissions]
    }
    case "gemini": {
      if (message.model !== undefined) s.metadata({ metadata: { model: message.model } })
      const tokens = message.tokens ?? undefined
      const cached = tokenCount(tokens?.cached)
      const input = tokenCount(tokens?.input)
      const thoughts = tokenCount(tokens?.thoughts)
      const output = tokenCount(tokens?.output)
      // Gemini counts cached tokens inside input and thoughts outside output; canonical usage is the reverse.
      const usage = usageFields({
        model: message.model,
        inputTokens: input === undefined ? undefined : input - (cached ?? 0),
        cacheReadTokens: cached,
        outputTokens: output === undefined ? undefined : output + (thoughts ?? 0),
        reasoningTokens: thoughts
      })
      if (Object.keys(usage).some((key) => key !== "model")) s.event({ type: "usage.recorded", certainty: "known", ...usage })
      for (const thought of message.thoughts ?? []) {
        const content = [thought.subject, thought.description].filter((x): x is string => !!x?.trim()).join(": ")
        if (content.length > 0) {
          s.event({
            type: "agent.reasoning",
            certainty: "known",
            content,
            representation: "summary",
            ...(thought.timestamp !== undefined ? { timestamp: thought.timestamp } : {})
          })
        }
      }
      const text = textOf(partsOf(message.content)).trim()
      if (text.length > 0) s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text }] })
      for (const call of message.toolCalls ?? []) normalizeToolCall(s, call, state.projectPath)
      return [state, s.emissions]
    }
  }
}

const normalizeToolCall = (s: RecordScope, call: GeminiToolCall, projectPath: string | undefined) => {
  const at = call.timestamp !== undefined ? { timestamp: call.timestamp } : {}
  const toolCallId = call.id as ToolCallId
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId,
    name: call.name,
    kind: toolKind(call.name),
    ...(call.args !== undefined ? { input: asJson(call.args) } : {}),
    ...at
  })
  const command = call.name === "run_shell_command" ? stringProp(call.args, "command") : undefined
  const commandStartedId = command === undefined ? undefined : s.event({
    type: "command.started",
    certainty: "known",
    commandId: call.id as CommandId,
    command,
    ...((stringProp(call.args, "directory") ?? projectPath) ? { cwd: stringProp(call.args, "directory") ?? projectPath! } : {}),
    parentEventId: startedId,
    derivedFrom: [startedId],
    ...at
  })

  if (call.status === undefined || !["success", "error", "cancelled"].includes(call.status)) return
  const output = functionOutput(s, call)
  const failed = call.status !== "success"
  const resultId: EventId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: output ?? call.status, ...at })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId, ...(output !== undefined ? { output } : {}), ...at })
  const link = { parentEventId: startedId, derivedFrom: [startedId, resultId], ...at }

  if (commandStartedId !== undefined) {
    const status = shellStatus(output, call.status)
    const stdout = output === undefined ? undefined : /^Output: ([\s\S]*?)^Error: /m.exec(output)?.[1]?.trimEnd()
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: call.id as CommandId,
      outcome: status.outcome,
      ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      ...(stdout !== undefined ? { stdout } : output !== undefined ? { stdout: output } : {}),
      ...link
    })
  }
  if (failed) return
  if (call.name === "write_todos") emitPlan(s, planList(call.args, "todos"), "description", { certainty: "known", ...link })

  const path = stringProp(call.args, "file_path", "absolute_path", "path")
  if (path === undefined) return
  switch (call.name) {
    case "read_file":
      s.event({ type: "file.read", certainty: "known", path, ...link })
      return
    case "write_file":
    case "replace": {
      const display = Option.getOrUndefined(decodeFileDiff(call.resultDisplay))
      const diff = display?.fileDiff ? { diff: display.fileDiff } : {}
      const created = /created and wrote to new file/i.test(output ?? "") || (call.name === "write_file" && display?.originalContent === null)
      if (created) s.event({ type: "file.created", certainty: "known", path, ...diff, ...link })
      else s.event({ type: "file.changed", certainty: "known", path, ...diff, ...link })
      return
    }
  }
}
