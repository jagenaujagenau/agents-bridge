import {
  type DecodedRecord,
  type Emission,
  makeLineDecoder,
  RecordScope,
  stringProp,
  textOf,
  titleFrom,
  warnUndecodable,
  tokenCount,
  usageFields
} from "@agentbridge/core"
import {
  type CommandId,
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
// Tool vocabulary
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
  grep: "search",
  find: "search",
  ls: "search"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

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
export const activePath = (entries: ReadonlyArray<readonly [id: string, parentId: string | undefined]>): ReadonlySet<string> | undefined => {
  const parents = new Map(entries)
  const last = entries.at(-1)?.[0]
  const path = new Set<string>()
  for (let id = last; id !== undefined && !path.has(id); id = parents.get(id)) path.add(id)
  return path.size === parents.size ? undefined : path
}

/** Whether a decoded line belongs to the active branch. Headers and id-less records always do. */
export const onPath = (path: ReadonlySet<string> | undefined) => (line: DecodedRecord<PiRecord>): boolean =>
  path === undefined || line._tag !== "Record" || line.record.type === "session" ||
  !("id" in line.record) || line.record.id === undefined || path.has(line.record.id)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OpenTool {
  readonly startedId: EventId
  readonly name: string
  readonly input: unknown
  readonly commandStartedId?: EventId
}

export interface PiState {
  readonly sessionId: SessionId
  readonly path: string
  readonly headerSeen: boolean
  readonly sawPrompt: boolean
  readonly cwd: string | undefined
  readonly tools: ReadonlyMap<string, OpenTool>
}

export const initialState = (sessionId: SessionId, path: string): PiState => ({
  sessionId,
  path,
  headerSeen: false,
  sawPrompt: false,
  cwd: undefined,
  tools: new Map()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decodeBlock = Schema.decodeUnknownOption(PiBlock)

/** `<timestamp>_<id>.jsonl` → id. */
export const idFromFileName = (file: string): string | undefined => /_([^_]+)\.jsonl$/.exec(file)?.[1]

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

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [PiState, ReadonlyArray<Emission>]

export const normalizeLine = (state: PiState, line: DecodedRecord<PiRecord>): Step => {
  if (line._tag === "Skip") return [state, []]
  const base = {
    harness: HARNESS,
    sessionId: state.sessionId,
    format: FORMAT,
    path: state.path,
    recordIndex: line.index
  }
  if (line._tag !== "Record") {
    const s = new RecordScope(base)
    warnUndecodable(s, line, NAME)
    return [state, s.emissions]
  }

  const record = line.record
  const s = new RecordScope({
    ...base,
    nativeEventId: "id" in record ? record.id : undefined,
    timestamp: record.timestamp
  })

  switch (record.type) {
    case "session": {
      // A file holds one session; ignore any repeated header.
      if (state.headerSeen) return [state, []]
      const parent = record.parentSession ? idFromFileName(record.parentSession) : undefined
      s.metadata({
        ...(record.cwd !== undefined ? { projectPath: record.cwd } : {}),
        ...(record.version !== undefined ? { metadata: { sessionFormatVersion: record.version } } : {}),
        ...(parent !== undefined
          ? { relationships: [{ type: "fork", from: state.sessionId, to: makeSessionId(HARNESS, parent) }] }
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
      const usage = usageFields({
        model: message.model,
        inputTokens: tokenCount(message.usage?.input),
        cacheReadTokens: tokenCount(message.usage?.cacheRead),
        cacheWriteTokens: tokenCount(message.usage?.cacheWrite),
        outputTokens: tokenCount(message.usage?.output)
      })
      if (Object.keys(usage).some((key) => key !== "model")) s.event({ type: "usage.recorded", certainty: "known", ...usage })
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        s.event({
          type: "harness.notice",
          certainty: "known",
          kind: message.stopReason === "aborted" ? "interruption" : "error",
          content: [{ type: "text", text: message.errorMessage ?? message.stopReason }]
        })
      }
      return [state, s.emissions]
    }
    case "toolResult":
      return [completeTool(state, s, message), s.emissions]
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
    kind: toolKind(block.name),
    ...(block.arguments !== undefined ? { input: asJson(block.arguments) } : {})
  })
  const command = block.name === "bash" ? stringProp(block.arguments, "command") : undefined
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

  if (open.commandStartedId !== undefined) {
    const status = bashStatus(text, failed)
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

  const path = stringProp(open.input, "path", "file_path")
  if (!failed && path !== undefined) {
    if (open.name === "read") s.event({ type: "file.read", certainty: "known", path, ...link })
    if (open.name === "write") s.event({ type: "file.changed", certainty: "known", path, ...link })
    if (open.name === "edit") {
      const diff = message.details?.diff
      s.event({ type: "file.changed", certainty: "known", path, ...(diff ? { diff } : {}), ...link })
    }
  }
  return { ...state, tools }
}
