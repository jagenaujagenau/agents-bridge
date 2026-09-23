import { type Emission, RecordScope, stringProp, titleFrom } from "@agentbridge/core"
import {
  type CommandId,
  type CommandOutcome,
  type ContentBlock,
  type EventId,
  makeSessionId,
  type PlanEntry,
  type SessionId,
  type ToolCallId,
  type ToolKind
} from "@agentbridge/schema"
import { HashMap, HashSet, Option, Schema } from "effect"
import {
  type AcpContentBlock,
  AcpPromptParams,
  AcpPromptResult,
  AcpSessionUpdate,
  type AcpToolCallContent,
  IGNORED_UPDATES,
  KNOWN_UPDATES
} from "./schema/AcpSchema.ts"

export const HARNESS = "acp"
export const NAME = "ACP"
export const FORMAT = "acp-v1-jsonrpc"

/** Canonical ID for an ACP session: `acp:<agent>/<acp session id>`. */
export const acpSessionId = (agent: string, sessionId: string): SessionId => makeSessionId(HARNESS, `${agent}/${sessionId}`)

/** One ACP message as observed on the wire, optionally stamped with when it was received. */
export interface AcpEnvelope {
  readonly index: number
  readonly receivedAt?: string | undefined
  readonly message: unknown
}

const decodeUpdate = Schema.decodeUnknownOption(AcpSessionUpdate)
const decodePrompt = Schema.decodeUnknownOption(AcpPromptParams)
const decodePromptResult = Schema.decodeUnknownOption(AcpPromptResult)

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch"])
const toolKind = (kind: string | null | undefined): ToolKind => (kind && ACP_TOOL_KINDS.has(kind) ? (kind as ToolKind) : "other")

const asJson = (value: unknown) => value as Schema.Json

const toContent = (blocks: ReadonlyArray<AcpContentBlock>): Array<ContentBlock> =>
  blocks.flatMap((block): Array<ContentBlock> => {
    if (block.type === "text" && block.text !== undefined) return [{ type: "text", text: block.text }]
    if (block.type === "image") {
      const uri = block.uri ?? (block.data !== undefined && block.mimeType ? `data:${block.mimeType};base64,${block.data}` : undefined)
      return uri === undefined ? [] : [{ type: "image", uri, ...(block.mimeType ? { mimeType: block.mimeType } : {}) }]
    }
    if (block.type === "resource_link" && block.uri) return [{ type: "file", path: block.uri.replace(/^file:\/\//, "") }]
    if (block.type === "resource" && block.resource?.uri) return [{ type: "file", path: block.resource.uri.replace(/^file:\/\//, "") }]
    return []
  })

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type ChunkRole = "user" | "agent" | "thought"

interface ChunkBuffer {
  readonly role: ChunkRole
  readonly messageId: string | undefined
  readonly index: number
  readonly receivedAt: string | undefined
  readonly text: string
  readonly extra: ReadonlyArray<ContentBlock>
}

interface ToolState {
  readonly startedId: EventId
  readonly kind: ToolKind
  readonly title: string | undefined
  readonly rawInput: unknown
  readonly rawOutput: unknown
  readonly status: string | undefined
  readonly content: ReadonlyArray<AcpToolCallContent>
  readonly locations: ReadonlyArray<string>
  readonly commandStartedId: EventId | undefined
}

export interface AcpState {
  readonly sessionId: SessionId
  /** The ACP session ID; messages for other sessions are ignored. */
  readonly acpSessionId: string
  readonly source: string
  readonly started: boolean
  readonly sawPrompt: boolean
  readonly buffer: ChunkBuffer | undefined
  readonly tools: HashMap.HashMap<string, ToolState>
  readonly finishedTools: HashSet.HashSet<string>
  readonly pendingPrompts: ReadonlySet<string>
  /** The prompt request whose response ends the current turn. */
  readonly turn: string | undefined
  /** `session/new` requests awaiting the response that names their session. */
  readonly pendingNew: ReadonlyMap<string, string | undefined>
}

export const initialState = (options: { readonly agent: string; readonly sessionId: string; readonly source: string }): AcpState => ({
  sessionId: acpSessionId(options.agent, options.sessionId),
  acpSessionId: options.sessionId,
  source: options.source,
  started: false,
  sawPrompt: false,
  buffer: undefined,
  tools: HashMap.empty(),
  finishedTools: HashSet.empty(),
  pendingPrompts: new Set(),
  turn: undefined,
  pendingNew: new Map()
})

type Step = readonly [AcpState, ReadonlyArray<Emission>]

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

const scopeFor = (state: AcpState, index: number, receivedAt: string | undefined) =>
  new RecordScope({ harness: HARNESS, sessionId: state.sessionId, format: FORMAT, path: state.source, recordIndex: index, timestamp: receivedAt })

/** Emit buffered message chunks as one message. */
const flush = (state: AcpState): Step => {
  const buffer = state.buffer
  if (buffer === undefined) return [state, []]
  let next: AcpState = { ...state, buffer: undefined }
  const s = scopeFor(state, buffer.index, buffer.receivedAt)
  const content: Array<ContentBlock> = [
    ...(buffer.text.length > 0 ? [{ type: "text" as const, text: buffer.text }] : []),
    ...buffer.extra
  ]
  if (content.length === 0) return [next, []]
  switch (buffer.role) {
    case "user":
      s.event({ type: "user.message", certainty: "known", content })
      if (!state.sawPrompt && buffer.text.length > 0) {
        s.metadata({ title: { value: titleFrom(buffer.text), priority: 10 } })
        next = { ...next, sawPrompt: true }
      }
      break
    case "agent":
      s.event({ type: "agent.message", certainty: "known", content })
      break
    case "thought":
      if (buffer.text.trim().length > 0) {
        s.event({ type: "agent.reasoning", certainty: "known", content: buffer.text, representation: "provider_exposed" })
      }
      break
  }
  return [next, s.emissions]
}

const begin = (state: AcpState, s: RecordScope): AcpState => {
  if (state.started) return state
  s.event({ type: "session.started", certainty: "known" })
  return { ...state, started: true }
}

/** Marks a recorded line that was not valid JSON. */
export const MALFORMED_JSON: unique symbol = Symbol.for("@agentbridge/adapter-acp/MalformedJson")

export const normalizeEnvelope = (initial: AcpState, envelope: AcpEnvelope): Step => {
  const message = envelope.message
  if (message === MALFORMED_JSON) {
    const s = scopeFor(initial, envelope.index, envelope.receivedAt)
    s.warning("malformed_json", "Skipped lines that are not valid JSON")
    return [initial, s.emissions]
  }
  if (typeof message !== "object" || message === null) {
    const s = scopeFor(initial, envelope.index, envelope.receivedAt)
    s.warning("malformed_record", "Skipped ACP messages that are not JSON objects")
    return [initial, s.emissions]
  }
  const record = message as Record<string, unknown>
  const method = typeof record["method"] === "string" ? record["method"] : undefined
  const params = (record["params"] ?? (method === undefined && "update" in record ? record : undefined)) as unknown

  // session/new and session/load carry the working directory.
  if (method === "session/new" || method === "session/load") {
    const cwd = stringProp(params, "cwd")
    const id = record["id"]
    if (method === "session/load" && stringProp(params, "sessionId") === initial.acpSessionId && cwd) {
      const s = scopeFor(initial, envelope.index, envelope.receivedAt)
      s.metadata({ projectPath: cwd })
      return [initial, s.emissions]
    }
    if (method === "session/new" && (typeof id === "string" || typeof id === "number")) {
      return [{ ...initial, pendingNew: new Map(initial.pendingNew).set(String(id), cwd) }, []]
    }
    return [initial, []]
  }
  if (method === undefined && initial.pendingNew.has(String(record["id"]))) {
    const cwd = initial.pendingNew.get(String(record["id"]))
    const pendingNew = new Map(initial.pendingNew)
    pendingNew.delete(String(record["id"]))
    const s = scopeFor(initial, envelope.index, envelope.receivedAt)
    if (stringProp(record["result"], "sessionId") === initial.acpSessionId && cwd) s.metadata({ projectPath: cwd })
    return [{ ...initial, pendingNew }, s.emissions]
  }

  // session/prompt request: the user's turn.
  if (method === "session/prompt") {
    const prompt = Option.getOrUndefined(decodePrompt(params))
    if (prompt === undefined || prompt.sessionId !== initial.acpSessionId) return [initial, []]
    const [flushed, before] = flush(initial)
    const s = scopeFor(flushed, envelope.index, envelope.receivedAt)
    let state = begin(flushed, s)
    const id = record["id"]
    if (typeof id === "string" || typeof id === "number") {
      if (state.turn !== undefined) {
        s.event({ type: "turn.completed", certainty: "inferred", turnId: state.turn, outcome: "unknown" })
      }
      s.event({ type: "turn.started", certainty: "known", turnId: String(id) })
      state = { ...state, turn: String(id), pendingPrompts: new Set([...state.pendingPrompts, String(id)]) }
    }
    const content = toContent(prompt.prompt)
    if (content.length > 0) {
      s.event({ type: "user.message", certainty: "known", content })
      const text = content.find((b) => b.type === "text")
      if (!state.sawPrompt && text?.type === "text") {
        s.metadata({ title: { value: titleFrom(text.text), priority: 10 } })
        state = { ...state, sawPrompt: true }
      }
    }
    return [state, [...before, ...s.emissions]]
  }

  // Response to a session/prompt: the turn ended.
  if (method === undefined && ("result" in record || "error" in record) && initial.pendingPrompts.has(String(record["id"]))) {
    const [flushed, before] = flush(initial)
    const pendingPrompts = new Set(flushed.pendingPrompts)
    pendingPrompts.delete(String(record["id"]))
    const result = Option.getOrUndefined(decodePromptResult(record["result"]))
    const s = scopeFor(flushed, envelope.index, envelope.receivedAt)
    const failed = "error" in record
    if (failed || result?.stopReason === "cancelled" || result?.stopReason === "refusal") {
      const message = failed ? stringProp(record["error"], "message") ?? "error" : result!.stopReason
      s.event({
        type: "harness.notice",
        certainty: "known",
        kind: result?.stopReason === "cancelled" ? "interruption" : "error",
        content: [{ type: "text", text: `Turn ended: ${message}` }]
      })
    }
    const turnId = String(record["id"])
    if (flushed.turn === turnId) {
      s.event({
        type: "turn.completed",
        certainty: "known",
        turnId,
        outcome: failed || result?.stopReason === "refusal" ? "failed" : result?.stopReason === "cancelled" ? "interrupted" : "completed"
      })
    }
    return [{ ...flushed, pendingPrompts, turn: flushed.turn === turnId ? undefined : flushed.turn }, [...before, ...s.emissions]]
  }

  if (method !== undefined && method !== "session/update") return [initial, []]
  if (typeof params !== "object" || params === null) return [initial, []]
  const notification = params as Record<string, unknown>
  if (notification["sessionId"] !== initial.acpSessionId) return [initial, []]

  const updateType = stringProp(notification["update"], "sessionUpdate")
  if (updateType === undefined || IGNORED_UPDATES.has(updateType)) return [initial, []]
  if (!KNOWN_UPDATES.has(updateType)) {
    const s = scopeFor(initial, envelope.index, envelope.receivedAt)
    s.warning("unknown_record_type", `Ignored unknown ACP session update "${updateType}"`)
    return [initial, s.emissions]
  }
  const update = Option.getOrUndefined(decodeUpdate(notification["update"]))
  if (update === undefined) {
    const s = scopeFor(initial, envelope.index, envelope.receivedAt)
    s.warning("malformed_record", `Skipped ACP ${updateType} updates that do not match the protocol schema`)
    return [initial, s.emissions]
  }
  return normalizeUpdate(initial, update, envelope)
}

const normalizeUpdate = (initial: AcpState, update: AcpSessionUpdate, envelope: AcpEnvelope): Step => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const role: ChunkRole = update.sessionUpdate === "user_message_chunk"
        ? "user"
        : update.sessionUpdate === "agent_message_chunk"
        ? "agent"
        : "thought"
      const messageId = update.messageId ?? undefined
      const current = initial.buffer
      const continues = current !== undefined && current.role === role &&
        (messageId === undefined || current.messageId === undefined || current.messageId === messageId)
      const [flushed, before] = continues ? [initial, []] as Step : flush(initial)
      const s = scopeFor(flushed, envelope.index, envelope.receivedAt)
      const state = begin(flushed, s)
      const base: ChunkBuffer = continues
        ? current!
        : { role, messageId, index: envelope.index, receivedAt: envelope.receivedAt, text: "", extra: [] }
      const isText = update.content.type === "text"
      const buffer: ChunkBuffer = {
        ...base,
        text: base.text + (isText ? update.content.text ?? "" : ""),
        extra: isText ? base.extra : [...base.extra, ...toContent([update.content])]
      }
      return [{ ...state, buffer }, [...before, ...s.emissions]]
    }
    case "plan": {
      const [flushed, before] = flush(initial)
      const s = scopeFor(flushed, envelope.index, envelope.receivedAt)
      const state = begin(flushed, s)
      const entries: Array<PlanEntry> = update.entries.map((entry) => ({
        content: entry.content,
        status: entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending",
        ...(entry.priority === "high" || entry.priority === "medium" || entry.priority === "low" ? { priority: entry.priority } : {})
      }))
      s.event({ type: "plan.updated", certainty: "known", entries })
      return [state, [...before, ...s.emissions]]
    }
    case "session_info_update": {
      const s = scopeFor(initial, envelope.index, envelope.receivedAt)
      if (update.title) s.metadata({ title: { value: update.title, priority: 30 } })
      return [initial, s.emissions]
    }
    case "tool_call":
    case "tool_call_update": {
      const [flushed, before] = flush(initial)
      const s = scopeFor(flushed, envelope.index, envelope.receivedAt)
      const state = begin(flushed, s)
      return [toolUpdate(state, s, update), [...before, ...s.emissions]]
    }
  }
}

const commandOf = (rawInput: unknown): string | undefined => {
  if (typeof rawInput !== "object" || rawInput === null) return undefined
  const command = (rawInput as Record<string, unknown>)["command"]
  if (typeof command === "string") return command
  if (Array.isArray(command)) return command.map(String).join(" ")
  return undefined
}

const toolUpdate = (
  state: AcpState,
  s: RecordScope,
  update: Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>
): AcpState => {
  if (HashSet.has(state.finishedTools, update.toolCallId)) return state
  let tool = Option.getOrUndefined(HashMap.get(state.tools, update.toolCallId))
  const existed = tool !== undefined
  const toolCallId = update.toolCallId as ToolCallId

  if (tool === undefined) {
    const kind = toolKind(update.kind)
    const name = update.title ?? update.kind ?? "tool"
    const startedId = s.event({
      type: "tool.started",
      certainty: "known",
      toolCallId,
      name,
      kind,
      ...(update.rawInput !== undefined ? { input: asJson(update.rawInput) } : {})
    })
    const command = kind === "execute" ? commandOf(update.rawInput) : undefined
    const commandStartedId = command === undefined ? undefined : s.event({
      type: "command.started",
      certainty: "known",
      commandId: update.toolCallId as CommandId,
      command,
      ...(stringProp(update.rawInput, "cwd") ? { cwd: stringProp(update.rawInput, "cwd")! } : {}),
      parentEventId: startedId,
      derivedFrom: [startedId]
    })
    tool = {
      startedId,
      kind,
      title: update.title ?? undefined,
      rawInput: update.rawInput,
      rawOutput: undefined,
      status: undefined,
      content: [],
      locations: [],
      commandStartedId
    }
  }

  // Omission preserves a field; null clears it. Arrays replace, never append.
  tool = {
    ...tool,
    ...(update.kind !== undefined ? { kind: toolKind(update.kind) } : {}),
    ...(update.title !== undefined ? { title: update.title ?? undefined } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.status !== undefined ? { status: update.status ?? undefined } : {}),
    ...(update.content !== undefined ? { content: update.content ?? [] } : {}),
    ...(update.locations !== undefined ? { locations: update.locations?.map((l) => l.path) ?? [] } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {})
  }
  if (existed && (update.kind !== undefined || update.title !== undefined || update.rawInput !== undefined)) {
    s.event({
      type: "tool.updated", certainty: "known", toolCallId,
      ...(update.title !== undefined ? { name: tool.title ?? tool.kind } : {}),
      ...(update.kind !== undefined ? { kind: tool.kind } : {}),
      ...(update.rawInput !== undefined ? { input: asJson(tool.rawInput) } : {}),
      parentEventId: tool.startedId, derivedFrom: [tool.startedId]
    })
  }
  const command = tool.kind === "execute" ? commandOf(tool.rawInput) : undefined
  if (tool.commandStartedId === undefined && command !== undefined) {
    const commandStartedId = s.event({
      type: "command.started", certainty: "known", commandId: update.toolCallId as CommandId, command,
      ...(stringProp(tool.rawInput, "cwd") ? { cwd: stringProp(tool.rawInput, "cwd")! } : {}),
      parentEventId: tool.startedId, derivedFrom: [tool.startedId]
    })
    tool = { ...tool, commandStartedId }
  }
  if (tool.status === "completed" || tool.status === "failed") {
    finishTool(s, update.toolCallId, tool)
    return { ...state, tools: HashMap.remove(state.tools, update.toolCallId), finishedTools: HashSet.add(state.finishedTools, update.toolCallId) }
  }
  return { ...state, tools: HashMap.set(state.tools, update.toolCallId, tool) }
}

const finishTool = (s: RecordScope, id: string, tool: ToolState) => {
  const failed = tool.status === "failed"
  const text = tool.content
    .flatMap((item) => (item.type === "content" && item.content?.text !== undefined ? [item.content.text] : []))
    .join("\n")
  const toolCallId = id as ToolCallId
  const resultId = failed
    ? s.event({ type: "tool.failed", certainty: "known", toolCallId, message: text || "failed" })
    : s.event({
      type: "tool.completed",
      certainty: "known",
      toolCallId,
      ...(text ? { output: text } : tool.rawOutput !== undefined ? { output: asJson(tool.rawOutput) } : {})
    })
  const link = { certainty: "known" as const, parentEventId: tool.startedId, derivedFrom: [tool.startedId, resultId] }

  if (tool.commandStartedId !== undefined) {
    const output = tool.rawOutput as Record<string, unknown> | undefined
    const exit = output?.["exitCode"] ?? output?.["exit_code"] ?? output?.["exitStatus"]
    const exitCode = typeof exit === "number" ? exit : undefined
    const outcome: CommandOutcome = exitCode !== undefined ? (exitCode === 0 ? "succeeded" : "failed") : failed ? "failed" : "succeeded"
    const stdout = stringProp(output, "stdout", "output") ?? (text || undefined)
    s.event({
      type: "command.completed",
      commandId: id as CommandId,
      outcome,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stringProp(output, "stderr") ? { stderr: stringProp(output, "stderr")! } : {}),
      ...link
    })
  }
  if (failed) return

  for (const item of tool.content) {
    if (item.type !== "diff" || item.path === undefined) continue
    if (item.oldText === null || item.oldText === undefined) s.event({ type: "file.created", path: item.path, ...link })
    else s.event({ type: "file.changed", path: item.path, ...link })
  }
  for (const path of tool.locations) {
    if (tool.kind === "read") s.event({ type: "file.read", path, ...link })
    if (tool.kind === "delete") s.event({ type: "file.deleted", path, ...link })
  }
}

/** Flush any message still being streamed when the stream ends. */
export const onHalt = (state: AcpState): ReadonlyArray<Emission> => flush(state)[1]

