import {
  type DecodedRecord,
  type Emission,
  endTurn,
  makeLineDecoder,
  parseJson,
  planEntries,
  RecordScope,
  type RecordScopeOptions,
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
  type ContentBlock,
  type EventId,
  makeSessionId,
  type NoticeKind,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import { Option, Schema } from "effect"
import {
  type AppendMessageRecord,
  type ApplyCompactionRecord,
  type ConfigRecord,
  type ContextMessage,
  decodeParts,
  type KimiPart,
  KimiRecord,
  KNOWN_LOOP_EVENTS,
  KNOWN_TYPES,
  LoopEvent,
  type LoopEventRecord,
  type MetadataRecord,
  METADATA_TYPES,
  type SubagentSpawnedRecord,
  type TaskTerminatedRecord,
  type TurnEndedRecord,
  type TurnPromptRecord,
  type UsageRecord
} from "./schema/KimiRecord.ts"

export const HARNESS = "kimi"
export const NAME = "Kimi Code"
export const FORMAT = "kimi-wire-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native Kimi Code tool names are interpreted)
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  ReadMediaFile: "read",
  Write: "edit",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  WebSearch: "search",
  FetchURL: "fetch",
  Bash: "execute"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

const COMMAND_TOOLS = new Set(["Bash"])
const TODO_TOOLS = new Set(["TodoList", "SetTodoList"])

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly display: unknown
  readonly commandStartedId?: EventId
}

export interface KimiState {
  readonly sessionId: SessionId
  readonly path: string
  /** The native ID of the session this wire belongs to (subagents are `<root>/<agentId>`). */
  readonly root: string
  readonly started: boolean
  readonly sawPrompt: boolean
  /** The open turn's ID. */
  readonly turn: string | undefined
  /** The engine's turn clock, for `turn.prompt` records without `turnId` (imported wires). */
  readonly nextTurnId: number
  readonly tools: ReadonlyMap<string, OpenTool>
  /** Background Bash calls, by tool call ID, completed by `task.terminated`. */
  readonly background: ReadonlyMap<string, { readonly startedId: EventId; readonly derivedFrom: ReadonlyArray<EventId> }>
  /** A `!command` typed by the user, waiting for its output message. */
  readonly userShell: CommandId | undefined
}

export const initialState = (sessionId: SessionId, path: string, root: string): KimiState => ({
  sessionId,
  path,
  root,
  started: false,
  sawPrompt: false,
  turn: undefined,
  nextTurnId: 0,
  tools: new Map(),
  background: new Map(),
  userShell: undefined
})

export const decodeLine = makeLineDecoder({ schema: KimiRecord, known: KNOWN_TYPES, ignored: METADATA_TYPES })

const decodeLoopEvent = Schema.decodeUnknownOption(LoopEvent)

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/** What a user-role context message is, from its `origin`. */
export type MessageClass =
  | { readonly _tag: "Prompt" }
  | { readonly _tag: "Slash"; readonly text: string }
  | { readonly _tag: "ShellInput" }
  | { readonly _tag: "ShellOutput"; readonly isError: boolean }
  | { readonly _tag: "Notice"; readonly kind: NoticeKind }
  | { readonly _tag: "Skip" }

/**
 * Classify a context message by its origin. Messages without an origin are prompts (the
 * engine's default origin is `user`). Subagent wires open with a `system_trigger:subagent`
 * prompt: the parent agent is that session's principal.
 */
export const classifyOrigin = (origin: unknown): MessageClass => {
  const kind = stringProp(origin, "kind")
  switch (kind) {
    case undefined:
    case "user":
      return { _tag: "Prompt" }
    case "system_trigger": {
      const name = stringProp(origin, "name")
      if (name === "subagent") return { _tag: "Prompt" }
      return { _tag: "Notice", kind: name === "stop_hook" ? "hook" : "other" }
    }
    case "skill_activation": {
      if (stringProp(origin, "trigger") !== "user-slash") return { _tag: "Notice", kind: "injected_context" }
      const args = stringProp(origin, "skillArgs")?.trim()
      return { _tag: "Slash", text: `/${stringProp(origin, "skillName") ?? "skill"}${args ? ` ${args}` : ""}` }
    }
    case "plugin_command": {
      const args = stringProp(origin, "commandArgs")?.trim()
      return { _tag: "Slash", text: `/${stringProp(origin, "commandName") ?? "command"}${args ? ` ${args}` : ""}` }
    }
    case "shell_command":
      return stringProp(origin, "phase") === "input"
        ? { _tag: "ShellInput" }
        : { _tag: "ShellOutput", isError: (origin as { isError?: unknown }).isError === true }
    case "injection":
      return { _tag: "Notice", kind: "injected_context" }
    case "task":
    case "background_task":
      return { _tag: "Notice", kind: "task_notification" }
    case "hook_result":
      return { _tag: "Notice", kind: "hook" }
    // The summary is read once, from `context.apply_compaction`.
    case "compaction_summary":
      return { _tag: "Skip" }
    default:
      // cron_job, cron_missed, retry and future origins.
      return { _tag: "Notice", kind: "other" }
  }
}

const NOTICE_PREFIXES: ReadonlyArray<readonly [string, NoticeKind]> = [
  ["<system-reminder>", "injected_context"],
  ["<system-notification>", "injected_context"]
]

/** Injected text inside a prompt: tagged parts, then well-known wrappers. */
export const partNoticeKind = (part: { readonly text: string; readonly meta?: unknown }): NoticeKind | undefined => {
  const source = stringProp(part.meta, "source")
  if (source === "skill activation") return "injected_context"
  if (source === "user prompt submit hook") return "hook"
  const trimmed = part.text.trimStart()
  for (const [prefix, kind] of NOTICE_PREFIXES) {
    if (trimmed.startsWith(prefix)) return kind
  }
  return undefined
}

const unescapeXml = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&")

export interface BashStatus {
  readonly outcome: "succeeded" | "failed" | "interrupted"
  readonly exitCode?: number
  readonly stdout: string
  /** Started in (or moved to) the background: the outcome arrives with `task.terminated`. */
  readonly background: boolean
}

/**
 * Status of a Bash tool result. Kimi Code records the exit code only in the text of a
 * failed result (`Command failed with exit code: N.`); a successful foreground command
 * has no recorded exit code.
 */
export const bashStatus = (output: string, isError: boolean): BashStatus => {
  if (!isError && output.startsWith("task_id: ") && /\nautomatic_notification: true\n/.test(output)) {
    return { outcome: "succeeded", stdout: "", background: true }
  }
  if (!isError) {
    return { outcome: "succeeded", stdout: output === "Command executed successfully." ? "" : output, background: false }
  }
  const failed = /(?:^|\n)Command failed with exit code: (-?\d+)\.\s*$/.exec(output)
  if (failed) {
    const stdout = output.slice(0, failed.index).replace(/^Process exited with code -?\d+$/, "")
    return { outcome: "failed", exitCode: Number(failed[1]), stdout, background: false }
  }
  if (/(?:^|\n)(?:Command killed by timeout \(|Interrupted by user$|Aborted before command started$)/.test(output)) {
    return { outcome: "interrupted", stdout: output, background: false }
  }
  return { outcome: "failed", stdout: output, background: false }
}

/** `task.terminated` status → command outcome. */
const taskOutcome = (status: string | undefined): "succeeded" | "failed" | "interrupted" | "unknown" | undefined => {
  switch (status) {
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "killed":
    case "timed_out":
      return "interrupted"
    case "lost":
      return "unknown"
    default:
      return undefined
  }
}

/** Kimi's TodoList items are `{ title, status: pending | in_progress | done }`. */
export const todoEntries = (todos: unknown): unknown =>
  Array.isArray(todos)
    ? todos.map((item) =>
      typeof item === "object" && item !== null
        ? {
          ...item,
          content: (item as { title?: unknown }).title,
          status: (item as { status?: unknown }).status === "done" ? "completed" : (item as { status?: unknown }).status
        }
        : item
    )
    : todos

/** `turn.ended.reason` → canonical turn outcome. */
const turnOutcome = (reason: string): "completed" | "interrupted" | "failed" | "unknown" => {
  switch (reason) {
    case "completed":
      return "completed"
    case "cancelled":
    case "blocked":
      return "interrupted"
    case "failed":
      return "failed"
    default:
      return "unknown"
  }
}

const timestampOf = (time: number | string | undefined): string | undefined =>
  typeof time === "number" ? (Number.isFinite(time) ? new Date(time).toISOString() : undefined) : time

const asJson = (value: unknown) => value as Schema.Json

/** Tool output: a string, or content parts. */
const outputText = (output: unknown): string => (typeof output === "string" ? output : textOf(output))

/** Prefer the display's resolved absolute path; else the argument as written. */
const toolPath = (tool: OpenTool): string | undefined => {
  const path = stringProp(tool.display, "path") ?? stringProp(tool.input, "path")
  return path === undefined || path.startsWith("kimi-file://") ? undefined : path
}

/** Imported (kimi-cli) and protocol 1.0 wires store arguments as a JSON string. */
const parseArgs = (args: unknown): unknown => {
  if (typeof args !== "string") return args ?? undefined
  return Option.getOrElse(parseJson(args), () => args)
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [KimiState, ReadonlyArray<Emission>]

export const normalizeLine = (state: KimiState, line: DecodedRecord<KimiRecord>): Step => {
  if (line._tag === "Skip") return [state, []]
  const base = { harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.path, recordIndex: line.index }
  if (line._tag !== "Record") {
    const s = new RecordScope(base)
    warnUndecodable(s, line, NAME)
    return [state, s.emissions]
  }
  const record = line.record
  const scope = (nativeEventId: string | undefined, time: number | string | undefined) =>
    new RecordScope({ ...base, nativeEventId, timestamp: timestampOf(time) })

  switch (record.type) {
    case "metadata":
      return normalizeMetadata(state, record, scope(undefined, record.created_at))
    case "config.update":
    case "profile.bind":
      return normalizeConfig(state, record, scope(undefined, record.time))
    case "turn.prompt":
      return normalizeTurnPrompt(state, record, scope(undefined, record.time))
    case "turn.ended":
      return normalizeTurnEnded(state, record, scope(undefined, record.time))
    case "context.append_message":
      return normalizeMessage(state, record, scope(record.message.id, record.time))
    case "context.append_loop_event":
      return normalizeLoopEvent(state, record, base)
    case "context.apply_compaction":
      return normalizeCompaction(state, record, scope(undefined, record.time))
    case "usage.record":
      return normalizeUsage(state, record, scope(undefined, record.time))
    case "subagent.spawned":
      return normalizeSubagentSpawned(state, record, scope(undefined, record.time))
    case "task.terminated":
      return normalizeTaskTerminated(state, record, scope(undefined, record.time))
  }
}

/** The wire header carries the creation time; headerless (1.4) wires start at their first timed record. */
const begin = (state: KimiState, s: RecordScope): KimiState => {
  if (state.started || s.options.timestamp === undefined) return state
  s.event({ type: "session.started", certainty: "known" })
  return { ...state, started: true }
}

const normalizeMetadata = (state: KimiState, record: MetadataRecord, s: RecordScope): Step => {
  if (record.protocol_version !== undefined) s.metadata({ metadata: { wireProtocolVersion: record.protocol_version } })
  return [begin(state, s), s.emissions]
}

const normalizeConfig = (initial: KimiState, record: ConfigRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  const cwd = stringProp(record.environmentDisclosure, "cwd")
  if (record.modelAlias !== undefined || cwd !== undefined) {
    s.metadata({
      ...(cwd !== undefined ? { projectPath: cwd } : {}),
      ...(record.modelAlias !== undefined ? { metadata: { model: record.modelAlias } } : {})
    })
  }
  return [state, s.emissions]
}

const normalizeTurnPrompt = (initial: KimiState, record: TurnPromptRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  const id = record.turnId ?? state.nextTurnId
  const turn = startTurn(s, state.turn, String(id))
  return [{ ...state, turn, nextTurnId: Math.max(state.nextTurnId, id + 1) }, s.emissions]
}

const normalizeTurnEnded = (initial: KimiState, record: TurnEndedRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  // Only the open turn can end; an end for another turn (copied by a fork) is history.
  if (state.turn === undefined || state.turn !== String(record.turnId)) return [state, s.emissions]
  const message = stringProp(record.error, "message")
  if (record.reason === "failed" && message !== undefined && message.length > 0) {
    s.event({ type: "harness.notice", certainty: "known", kind: "error", content: [{ type: "text", text: message }] })
  }
  const turn = endTurn(s, state.turn, turnOutcome(record.reason), { durationMs: record.durationMs })
  return [{ ...state, turn }, s.emissions]
}

// ---------------------------------------------------------------------------
// Context messages
// ---------------------------------------------------------------------------

const blocksOf = (parts: ReadonlyArray<KimiPart>): Array<ContentBlock> =>
  parts.flatMap((part): Array<ContentBlock> => {
    if (part.type === "text") return part.text.length > 0 ? [{ type: "text", text: part.text }] : []
    if (part.type === "image_url") return [{ type: "image", uri: part.imageUrl.url }]
    return []
  })

const normalizeMessage = (initial: KimiState, record: AppendMessageRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  const message = record.message
  const parts = decodeParts(message.content)
  switch (message.role) {
    case "user":
      return [userMessage(state, s, message, parts), s.emissions]
    case "assistant":
      return [assistantMessage(state, s, message, parts), s.emissions]
    case "tool": {
      // Only imported wires store tool results as messages; live wires use `tool.result` loop events.
      if (message.toolCallId === undefined) {
        s.warning("malformed_record", "Skipped tool results without a tool call ID")
        return [state, s.emissions]
      }
      return [completeTool(state, s, message.toolCallId, message.content, message.isError === true), s.emissions]
    }
    default: {
      const content = blocksOf(parts)
      if (content.length > 0) s.event({ type: "harness.notice", certainty: "known", kind: "other", content })
      return [state, s.emissions]
    }
  }
}

const userMessage = (initial: KimiState, s: RecordScope, message: ContextMessage, parts: ReadonlyArray<KimiPart>): KimiState => {
  let state = initial
  const content = blocksOf(parts)
  const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
  const cls = classifyOrigin(message.origin)
  switch (cls._tag) {
    case "Skip":
      return state
    case "Notice":
      if (content.length > 0) s.event({ type: "harness.notice", certainty: "known", kind: cls.kind, content })
      return state
    case "Slash":
      // The user typed a slash command; the message holds its expansion.
      state = prompt(state, s, [{ type: "text", text: cls.text }])
      if (content.length > 0) s.event({ type: "harness.notice", certainty: "known", kind: "injected_context", content })
      return state
    case "ShellInput": {
      const command = /<bash-input>\n?([\s\S]*?)\n?<\/bash-input>/.exec(text)?.[1]
      if (command === undefined) return state
      const commandId = (message.id ?? s.nextId("command.started")) as CommandId
      state = prompt(state, s, [{ type: "text", text: `!${unescapeXml(command)}` }])
      s.event({ type: "command.started", certainty: "known", commandId, command: unescapeXml(command) })
      return { ...state, userShell: commandId }
    }
    case "ShellOutput": {
      if (state.userShell === undefined) {
        if (content.length > 0) s.event({ type: "harness.notice", certainty: "known", kind: "command_output", content })
        return state
      }
      const stdout = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(text)?.[1]
      const stderr = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(text)?.[1]
      // The output message records failure but no exit status.
      s.event({
        type: "command.completed",
        certainty: "known",
        commandId: state.userShell,
        outcome: cls.isError ? "failed" : "succeeded",
        ...(stdout ? { stdout: unescapeXml(stdout) } : {}),
        ...(stderr ? { stderr: unescapeXml(stderr) } : {})
      })
      return { ...state, userShell: undefined }
    }
    case "Prompt":
      return promptParts(state, s, message.origin, parts)
  }
}

/**
 * A prompt's parts, minus injected ones. A `user` origin may list bundled skill
 * activations whose expansions are the first untagged text parts.
 */
const promptParts = (state: KimiState, s: RecordScope, origin: unknown, parts: ReadonlyArray<KimiPart>): KimiState => {
  const bundled = Array.isArray((origin as { skillActivations?: unknown } | undefined)?.skillActivations)
    ? ((origin as { skillActivations: ReadonlyArray<unknown> }).skillActivations.length)
    : 0
  // Mirrors the engine's `annotateBundledSkillParts`: only when no part is tagged yet.
  const tagged = parts.some((p) => p.type === "text" && stringProp(p.meta, "source") === "skill activation")
  let untaggedSkills = tagged ? 0 : bundled
  const own: Array<ContentBlock> = []
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length === 0) continue
      let kind = partNoticeKind(part)
      if (untaggedSkills > 0 && stringProp(part.meta, "source") === undefined) {
        untaggedSkills--
        kind = "injected_context"
      }
      if (kind !== undefined) s.event({ type: "harness.notice", certainty: "known", kind, content: [{ type: "text", text: part.text }] })
      else own.push({ type: "text", text: part.text })
    } else if (part.type === "image_url") {
      own.push({ type: "image", uri: part.imageUrl.url })
    }
  }
  return own.length > 0 ? prompt(state, s, own) : state
}

const prompt = (state: KimiState, s: RecordScope, content: ReadonlyArray<ContentBlock>): KimiState => {
  s.event({ type: "user.message", certainty: "known", content: [...content] })
  if (state.sawPrompt) return state
  const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
  if (text.trim().length === 0) return state
  s.metadata({ title: { value: titleFrom(text), priority: 10 } })
  return { ...state, sawPrompt: true }
}

/** Assistant messages: blocked-hook replies, and the whole transcript of imported wires. */
const assistantMessage = (initial: KimiState, s: RecordScope, message: ContextMessage, parts: ReadonlyArray<KimiPart>): KimiState => {
  let state = initial
  if (stringProp(message.origin, "kind") === "hook_result") {
    const content = blocksOf(parts)
    if (content.length > 0) s.event({ type: "harness.notice", certainty: "known", kind: "hook", content })
    return state
  }
  for (const part of parts) emitPart(s, part)
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : []
  for (const call of calls) {
    const id = stringProp(call, "id")
    const fn = (call as { function?: unknown }).function
    const name = stringProp(call, "name") ?? stringProp(fn, "name")
    if (id === undefined || name === undefined) {
      s.warning("malformed_record", "Skipped tool calls without an ID or name")
      continue
    }
    const args = (call as { arguments?: unknown }).arguments ?? (fn as { arguments?: unknown } | undefined)?.arguments
    state = startTool(state, s, id, name, parseArgs(args), undefined)
  }
  return state
}

/** One assistant content part: text is a message, exposed thinking is reasoning. */
const emitPart = (s: RecordScope, part: KimiPart) => {
  switch (part.type) {
    case "text":
      if (part.text.length > 0) s.event({ type: "agent.message", certainty: "known", content: [{ type: "text", text: part.text }] })
      return
    case "image_url":
      s.event({ type: "agent.message", certainty: "known", content: [{ type: "image", uri: part.imageUrl.url }] })
      return
    case "think":
      // Encrypted-only or hidden thinking has no readable text; never reconstruct it.
      if (part.hidden !== true && part.think.trim().length > 0) {
        s.event({ type: "agent.reasoning", certainty: "known", content: part.think, representation: "provider_exposed" })
      }
      return
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// Loop events
// ---------------------------------------------------------------------------

const normalizeLoopEvent = (
  initial: KimiState,
  record: LoopEventRecord,
  base: Omit<RecordScopeOptions, "nativeEventId" | "timestamp">
): Step => {
  const timestamp = timestampOf(record.time)
  const nativeType = stringProp(record.event, "type")
  if (nativeType === undefined || !KNOWN_LOOP_EVENTS.has(nativeType)) {
    const s = new RecordScope({ ...base, timestamp })
    if (nativeType === undefined) s.warning("malformed_record", "Skipped records that do not match the expected context.append_loop_event shape")
    else s.warning("unknown_record_type", `Ignored unknown ${NAME} record type "context.append_loop_event/${nativeType}"`)
    return [initial, s.emissions]
  }
  const decoded = decodeLoopEvent(record.event)
  if (Option.isNone(decoded)) {
    const s = new RecordScope({ ...base, timestamp })
    s.warning("malformed_record", `Skipped records that do not match the expected ${nativeType} shape`)
    return [initial, s.emissions]
  }
  const event = decoded.value
  switch (event.type) {
    case "step.begin":
    case "step.end": {
      const s = new RecordScope({ ...base, timestamp })
      return [begin(initial, s), s.emissions]
    }
    case "content.part": {
      const s = new RecordScope({ ...base, nativeEventId: event.uuid, timestamp })
      const state = begin(initial, s)
      emitPart(s, decodeParts([event.part])[0]!)
      return [state, s.emissions]
    }
    case "tool.call": {
      const s = new RecordScope({ ...base, nativeEventId: event.uuid, timestamp })
      const state = begin(initial, s)
      return [startTool(state, s, event.toolCallId, event.name, event.args, event.display), s.emissions]
    }
    case "tool.result": {
      // `parentUuid` is the call's UUID; suffixed so the two records never share an identity.
      const nativeEventId = event.parentUuid !== undefined ? `${event.parentUuid}:result` : undefined
      const s = new RecordScope({ ...base, nativeEventId, timestamp })
      const state = begin(initial, s)
      return [completeTool(state, s, event.toolCallId, event.result.output, event.result.isError === true), s.emissions]
    }
  }
}

const startTool = (state: KimiState, s: RecordScope, toolCallId: string, name: string, input: unknown, display: unknown): KimiState => {
  const startedId = s.event({
    type: "tool.started",
    certainty: "known",
    toolCallId: toolCallId as ToolCallId,
    name,
    kind: toolKind(name),
    ...(input !== undefined ? { input: asJson(input) } : {})
  })
  let commandStartedId: EventId | undefined
  const command = COMMAND_TOOLS.has(name) ? stringProp(input, "command") : undefined
  if (command !== undefined) {
    const cwd = stringProp(input, "cwd") ?? stringProp(display, "cwd")
    commandStartedId = s.event({
      type: "command.started",
      certainty: "known",
      commandId: toolCallId as CommandId,
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      parentEventId: startedId,
      derivedFrom: [startedId]
    })
  }
  const tools = new Map(state.tools)
  tools.set(toolCallId, { startedId, name, input, display, ...(commandStartedId !== undefined ? { commandStartedId } : {}) })
  return { ...state, tools }
}

const completeTool = (state: KimiState, s: RecordScope, toolCallId: string, output: unknown, failed: boolean): KimiState => {
  const open = state.tools.get(toolCallId)
  if (open === undefined) {
    s.warning("orphan_tool_result", "Tool results without a matching tool call")
    return state
  }
  const text = outputText(output)
  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId: toolCallId as ToolCallId, message: text })
    : s.event({ type: "tool.completed", certainty: "known", toolCallId: toolCallId as ToolCallId, output: text })
  const tools = new Map(state.tools)
  tools.delete(toolCallId)
  const derivedFrom = [open.startedId, resultId]
  let next: KimiState = { ...state, tools }

  let succeeded = !failed
  if (open.commandStartedId !== undefined) {
    const status = bashStatus(text, failed)
    if (status.background) {
      const background = new Map(state.background)
      background.set(toolCallId, { startedId: open.startedId, derivedFrom })
      return { ...next, background }
    }
    succeeded = status.outcome === "succeeded"
    s.event({
      type: "command.completed",
      certainty: "known",
      commandId: toolCallId as CommandId,
      outcome: status.outcome,
      ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      ...(status.stdout.length > 0 ? { stdout: status.stdout } : {}),
      parentEventId: open.startedId,
      derivedFrom
    })
  }
  if (succeeded) next = emitEffects(next, s, open, derivedFrom)
  return next
}

const emitEffects = (state: KimiState, s: RecordScope, tool: OpenTool, derivedFrom: Array<EventId>): KimiState => {
  const link = { certainty: "known" as const, parentEventId: tool.startedId, derivedFrom }
  const path = toolPath(tool)
  switch (tool.name) {
    case "Read":
    case "ReadMediaFile":
      if (path !== undefined) s.event({ type: "file.read", path, ...link })
      return state
    case "Edit":
      if (path !== undefined) s.event({ type: "file.changed", path, ...link })
      return state
    case "Write":
      if (path === undefined) return state
      // Write overwrites an existing file and reports "Wrote N bytes" either way.
      if (stringProp(tool.input, "mode") === "append") s.event({ type: "file.changed", path, ...link })
      else s.event({ type: "file.created", path, ...link, certainty: "inferred" })
      return state
    default:
      if (TODO_TOOLS.has(tool.name)) {
        // `todos` omitted means "read the list": no update.
        const todos = (tool.input as { todos?: unknown } | undefined)?.todos
        if (todos === undefined) return state
        const entries = planEntries(todoEntries(todos), "content")
        if (entries === undefined) s.warning("malformed_record", "Skipped malformed plan updates")
        else s.event({ type: "plan.updated", entries, ...link })
      }
      return state
  }
}

const normalizeTaskTerminated = (initial: KimiState, record: TaskTerminatedRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  const parent = stringProp(record.info, "parentToolCallId")
  const pending = parent === undefined ? undefined : state.background.get(parent)
  const outcome = taskOutcome(stringProp(record.info, "status"))
  if (parent === undefined || pending === undefined || outcome === undefined) return [state, s.emissions]
  const exitCode = (record.info as { exitCode?: unknown }).exitCode
  s.event({
    type: "command.completed",
    certainty: "known",
    commandId: parent as CommandId,
    outcome,
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
    ...(record.outputTail !== undefined && record.outputTail.length > 0 ? { stdout: record.outputTail } : {}),
    parentEventId: pending.startedId,
    derivedFrom: [...pending.derivedFrom]
  })
  const background = new Map(state.background)
  background.delete(parent)
  return [{ ...state, background }, s.emissions]
}

// ---------------------------------------------------------------------------
// Compaction, usage, subagents
// ---------------------------------------------------------------------------

const normalizeCompaction = (initial: KimiState, record: ApplyCompactionRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  const summary = typeof record.summary === "string"
    ? record.summary
    : record.summary !== undefined
    ? textOf((record.summary as { content?: unknown }).content)
    : record.contextSummary ?? ""
  s.event({ type: "context.compacted", certainty: "known", ...(summary.length > 0 ? { summary } : {}) })
  return [state, s.emissions]
}

/**
 * One `usage.record` per completed LLM request. `inputOther` excludes cache reads and
 * writes and `output` includes reasoning, which is the canonical split. The requester
 * records all zeroes when the provider reported nothing; that is not usage.
 */
const normalizeUsage = (initial: KimiState, record: UsageRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  const u = record.usage
  const fields = usageFields({
    model: record.model,
    inputTokens: tokenCount((u as { inputOther?: unknown } | undefined)?.inputOther),
    cacheReadTokens: tokenCount((u as { inputCacheRead?: unknown } | undefined)?.inputCacheRead),
    cacheWriteTokens: tokenCount((u as { inputCacheCreation?: unknown } | undefined)?.inputCacheCreation),
    outputTokens: tokenCount((u as { output?: unknown } | undefined)?.output)
  })
  const counts = Object.entries(fields).filter(([key]) => key !== "model").map(([, v]) => v as number)
  if (counts.some((n) => n > 0)) s.event({ type: "usage.recorded", certainty: "known", ...fields })
  return [state, s.emissions]
}

const normalizeSubagentSpawned = (initial: KimiState, record: SubagentSpawnedRecord, s: RecordScope): Step => {
  const state = begin(initial, s)
  s.metadata({
    relationships: [{ type: "child", from: state.sessionId, to: makeSessionId(HARNESS, `${state.root}/${record.subagentId}`) }]
  })
  return [state, s.emissions]
}
