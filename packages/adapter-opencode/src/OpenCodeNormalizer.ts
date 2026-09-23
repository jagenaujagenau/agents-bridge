import {
  type Emission,
  emitPlan,
  planList,
  makeRecordDecoder,
  parseJson,
  RecordScope,
  stringProp,
  titleFrom,
  warnUndecodable,
  tokenCount,
  usageFields
} from "@agentbridge/core"
import type { CommandId, CommandOutcome, ContentBlock, EventId, NoticeKind, SessionId, ToolCallId, ToolKind } from "@agentbridge/schema"
import { Option, Schema } from "effect"
import {
  IGNORED_PART_TYPES,
  KNOWN_PART_TYPES,
  OpenCodeMessage,
  OpenCodePart,
  type PartRow,
  type ToolPart
} from "./schema/OpenCodeRecord.ts"

export const HARNESS = "opencode"
export const NAME = "OpenCode"
export const FORMAT = "opencode-sqlite"

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  patch: "edit",
  apply_patch: "edit",
  multiedit: "edit",
  bash: "execute",
  glob: "search",
  grep: "search",
  list: "search",
  codesearch: "search",
  websearch: "search",
  webfetch: "fetch",
  todowrite: "think",
  todoread: "think"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

/** A message and its parts, in storage order. */
export interface MessageGroup {
  readonly ordinal: number
  readonly messageId: string
  readonly messageData: string
  readonly parts: ReadonlyArray<{ readonly id: string; readonly data: string }>
}

export const groupOf = (ordinal: number, rows: ReadonlyArray<PartRow>): MessageGroup => ({
  ordinal,
  messageId: rows[0]!.message_id,
  messageData: rows[0]!.message_data,
  parts: rows.flatMap((row) => (row.part_id !== null && row.part_data !== null ? [{ id: row.part_id, data: row.part_data }] : []))
})

export interface OpenCodeState {
  readonly sessionId: SessionId
  readonly database: string
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly cwd: string | undefined
}

export const initialState = (sessionId: SessionId, database: string, cwd: string | undefined): OpenCodeState => ({
  sessionId,
  database,
  started: false,
  sawPrompt: false,
  cwd
})

const decodeMessage = Schema.decodeUnknownOption(OpenCodeMessage)
const decodePart = makeRecordDecoder({ schema: OpenCodePart, known: KNOWN_PART_TYPES, ignored: IGNORED_PART_TYPES })

const iso = (millis: number | null | undefined) =>
  typeof millis === "number" && Number.isFinite(millis) ? new Date(millis).toISOString() : undefined

const asJson = (value: unknown) => value as Schema.Json

const INJECTED_PREFIXES = ["<system-reminder>", "<environment_details>"]

type Step = readonly [OpenCodeState, ReadonlyArray<Emission>]

export const normalizeGroup = (initial: OpenCodeState, group: MessageGroup): Step => {
  let state = initial
  const emissions: Array<Emission> = []
  const scopeFor = (nativeEventId: string, timestamp: string | undefined) =>
    new RecordScope({
      harness: HARNESS,
      sessionId: state.sessionId,
      format: FORMAT,
      path: state.database,
      recordIndex: group.ordinal,
      nativeEventId,
      timestamp
    })

  const messageScope = scopeFor(group.messageId, undefined)
  const message = Option.getOrUndefined(Option.flatMap(parseJson(group.messageData), decodeMessage))
  if (message === undefined) {
    messageScope.warning("malformed_record", "Skipped messages that do not match the expected message shape")
    return [state, messageScope.emissions]
  }
  const created = iso(message.time?.created)
  const head = scopeFor(group.messageId, created)

  if (!state.started) {
    head.event({ type: "session.started", certainty: "known" })
    state = { ...state, started: true }
  }
  if (message.role === "assistant") {
    if (message.modelID !== undefined) head.metadata({ metadata: { model: message.modelID } })
    if (message.path?.cwd !== undefined) state = { ...state, cwd: message.path.cwd }
  }

  // User text and attachments form one prompt, anchored on the message.
  const prompt: Array<ContentBlock> = []
  const notices: Array<{ kind: NoticeKind; text: string }> = []

  for (const raw of group.parts) {
    const s = scopeFor(raw.id, created)
    const json = parseJson(raw.data)
    if (Option.isNone(json)) {
      s.warning("malformed_json", "Skipped parts that are not valid JSON")
      emissions.push(...s.emissions)
      continue
    }
    const decoded = decodePart(group.ordinal, json.value)
    if (decoded._tag === "Skip") continue
    if (decoded._tag !== "Record") {
      warnUndecodable(s, decoded, NAME)
      emissions.push(...s.emissions)
      continue
    }
    const part = decoded.record
    switch (part.type) {
      case "text": {
        if (part.ignored === true || part.text.trim().length === 0) break
        if (message.role === "user") {
          const injected = part.synthetic === true || INJECTED_PREFIXES.some((p) => part.text.trimStart().startsWith(p))
          if (injected) notices.push({ kind: "injected_context", text: part.text })
          else prompt.push({ type: "text", text: part.text })
        } else {
          s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: part.text }] })
        }
        break
      }
      case "reasoning":
        if (part.text.trim().length > 0) {
          s.event({ type: "agent.reasoning", certainty: "known", content: part.text, representation: "provider_exposed" })
        }
        break
      case "file": {
        const path = part.source?.path ?? part.filename
        if (path !== undefined) prompt.push({ type: "file", path })
        break
      }
      case "compaction":
        s.event({ type: "context.compacted", certainty: "known" })
        break
      case "step-finish": {
        const tokens = part.tokens
        const reasoning = tokenCount(tokens?.reasoning)
        const output = tokenCount(tokens?.output)
        const fields = usageFields({
          model: message.role === "assistant" ? message.modelID : undefined,
          inputTokens: tokenCount(tokens?.input),
          cacheReadTokens: tokenCount(tokens?.cache?.read),
          cacheWriteTokens: tokenCount(tokens?.cache?.write),
          // OpenCode reports reasoning separately from output; the canonical outputTokens includes it.
          outputTokens: output === undefined ? undefined : output + (reasoning ?? 0),
          reasoningTokens: reasoning
        })
        if (Object.keys(fields).some((key) => key !== "model")) s.event({ type: "usage.recorded", certainty: "known", ...fields })
        break
      }
      case "tool":
        normalizeTool(s, part, state.cwd)
        break
    }
    emissions.push(...s.emissions)
  }

  if (message.role === "user") {
    const s = scopeFor(group.messageId, created)
    for (const notice of notices) {
      s.event({ type: "harness.notice", certainty: "known", kind: notice.kind, content: [{ type: "text", text: notice.text }] })
    }
    if (prompt.length > 0) {
      s.event({ type: "user.message", certainty: "known", content: prompt })
      const first = prompt.find((b) => b.type === "text")
      if (!state.sawPrompt && first?.type === "text") {
        s.metadata({ title: { value: titleFrom(first.text), priority: 10 } })
        state = { ...state, sawPrompt: true }
      }
    }
    // Prompt events come first within the message; tool parts never appear on user messages.
    return [state, [...head.emissions, ...s.emissions, ...emissions]]
  }

  const error = message.error
  if (error?.name) {
    const s = scopeFor(group.messageId, iso(message.time?.completed) ?? created)
    s.event({
      type: "harness.notice",
      certainty: "known",
      kind: error.name === "MessageAbortedError" ? "interruption" : "error",
      content: [{ type: "text", text: error.data?.message ?? error.name }]
    })
    emissions.push(...s.emissions)
  }
  return [state, [...head.emissions, ...emissions]]
}

const normalizeTool = (s: RecordScope, part: ToolPart, cwd: string | undefined) => {
  const { state } = part
  const started = iso(state.time?.start)
  const ended = iso(state.time?.end)
  const toolCallId = part.callID as ToolCallId
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId,
    name: part.tool,
    kind: toolKind(part.tool),
    ...(started !== undefined ? { timestamp: started } : {}),
    ...(state.input !== undefined ? { input: asJson(state.input) } : {})
  })
  const command = part.tool === "bash" ? stringProp(state.input, "command") : undefined
  const commandStartedId = command === undefined ? undefined : s.event({
    type: "command.started",
    certainty: "known",
    commandId: part.callID as CommandId,
    command,
    ...(stringProp(state.input, "workdir") ?? cwd ? { cwd: stringProp(state.input, "workdir") ?? cwd! } : {}),
    ...(started !== undefined ? { timestamp: started } : {}),
    parentEventId: startedId,
    derivedFrom: [startedId]
  })

  // pending / running parts have no outcome yet.
  if (state.status !== "completed" && state.status !== "error") return
  const failed = state.status === "error"
  const output = typeof state.output === "string" ? state.output : undefined
  const durationMs = typeof state.time?.start === "number" && typeof state.time?.end === "number"
    ? state.time.end - state.time.start
    : undefined
  const at = {
    ...(ended !== undefined ? { timestamp: ended } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
  const resultId: EventId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: state.error ?? output ?? "error", ...at })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId, ...(output !== undefined ? { output } : {}), ...at })
  const link = { parentEventId: startedId, derivedFrom: [startedId, resultId], ...at }
  const metadata = state.metadata ?? {}

  if (commandStartedId !== undefined) {
    const exit = metadata["exit"]
    const exitCode = typeof exit === "number" ? exit : undefined
    const outcome: CommandOutcome = exitCode !== undefined
      ? (exitCode === 0 ? "succeeded" : "failed")
      : failed
      ? (/abort|interrupt|cancel/i.test(state.error ?? "") ? "interrupted" : "failed")
      : "unknown"
    const stdout = typeof metadata["output"] === "string" ? metadata["output"] : output
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: part.callID as CommandId,
      outcome,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(stdout !== undefined ? { stdout } : {}),
      ...link
    })
  }

  if (failed) return
  if (part.tool === "todowrite") emitPlan(s, planList(state.input, "todos"), "content", { certainty: "known", ...link })
  const path = stringProp(state.input, "filePath", "path")
  if (path === undefined) return
  switch (part.tool) {
    case "read":
      s.event({ type: "file.read", certainty: "known", path, ...link })
      break
    case "write":
      if (metadata["exists"] === false) s.event({ type: "file.created", certainty: "known", path, ...link })
      else s.event({ type: "file.changed", certainty: "known", path, ...link })
      break
    case "edit": {
      const diff = typeof metadata["diff"] === "string" ? metadata["diff"] : undefined
      s.event({ type: "file.changed", certainty: "known", path, ...(diff ? { diff } : {}), ...link })
      break
    }
  }
}
