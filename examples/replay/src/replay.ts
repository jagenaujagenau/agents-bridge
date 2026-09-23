import { Bridge, type BridgeError } from "@agentbridge/core"
import { type PlanEntry, plainText, type Session, type SessionEvent } from "@agentbridge/schema"
import { Effect, Stream } from "effect"

/**
 * A miniature Replay (spec §80): the panes a session replay UI needs, built
 * from `Session` + `Stream<SessionEvent>` alone.
 *
 * This module is the architectural test subject. It must never reference a
 * harness by name, `harness.id`, `source.provider`, or native tool names.
 */

export interface ConversationEntry {
  readonly role: "user" | "agent" | "reasoning" | "notice"
  readonly text: string
  readonly at?: string | undefined
}

export interface TerminalEntry {
  readonly command: string
  readonly cwd?: string | undefined
  readonly outcome: string
  readonly exitCode?: number | undefined
  readonly output?: string | undefined
}

export interface FileEntry {
  readonly change: "read" | "created" | "changed" | "deleted"
  readonly path: string
  readonly hasDiff: boolean
  readonly inferred: boolean
}

export interface ToolEntry {
  readonly kind: string
  readonly name: string
  readonly status: "running" | "completed" | "failed"
}

export interface Replay {
  readonly title: string
  readonly subagentOf?: string | undefined
  readonly conversation: ReadonlyArray<ConversationEntry>
  readonly terminal: ReadonlyArray<TerminalEntry>
  readonly files: ReadonlyArray<FileEntry>
  readonly tools: ReadonlyArray<ToolEntry>
  /** The latest plan the agent published, if any. */
  readonly plan: ReadonlyArray<PlanEntry>
  readonly timeline: { readonly start?: string | undefined; readonly end?: string | undefined; readonly steps: number }
  /** Panes a UI can enable, decided by capability rather than by harness. */
  readonly panes: ReadonlyArray<"conversation" | "terminal" | "files" | "tools" | "reasoning">
}

interface Accumulator {
  conversation: Array<ConversationEntry>
  terminal: Map<string, TerminalEntry>
  files: Array<FileEntry>
  tools: Map<string, ToolEntry>
  plan: ReadonlyArray<PlanEntry>
  start?: string | undefined
  end?: string | undefined
  steps: number
}

const step = (acc: Accumulator, event: SessionEvent): Accumulator => {
  acc.steps++
  if (event.timestamp !== undefined) {
    acc.start ??= event.timestamp
    acc.end = event.timestamp
  }
  switch (event.type) {
    case "user.message":
      acc.conversation.push({ role: "user", text: plainText(event.content), at: event.timestamp })
      break
    case "agent.message":
      acc.conversation.push({ role: "agent", text: plainText(event.content), at: event.timestamp })
      break
    case "agent.reasoning":
      acc.conversation.push({ role: "reasoning", text: event.content, at: event.timestamp })
      break
    case "harness.notice":
      acc.conversation.push({ role: "notice", text: event.kind, at: event.timestamp })
      break
    case "command.started":
      acc.terminal.set(event.commandId, { command: event.command, cwd: event.cwd, outcome: "running" })
      break
    case "command.completed": {
      const started = acc.terminal.get(event.commandId)
      if (started !== undefined) {
        acc.terminal.set(event.commandId, {
          ...started,
          outcome: event.outcome,
          exitCode: event.exitCode,
          output: event.stdout
        })
      }
      break
    }
    case "file.read":
      acc.files.push({ change: "read", path: event.path, hasDiff: false, inferred: event.certainty !== "known" })
      break
    case "file.created":
    case "file.changed":
      acc.files.push({
        change: event.type === "file.created" ? "created" : "changed",
        path: event.path,
        hasDiff: event.diff !== undefined,
        inferred: event.certainty !== "known"
      })
      break
    case "file.deleted":
      acc.files.push({ change: "deleted", path: event.path, hasDiff: false, inferred: event.certainty !== "known" })
      break
    case "plan.updated":
      acc.plan = event.entries
      break
    case "tool.started":
      acc.tools.set(event.toolCallId, { kind: event.kind, name: event.name, status: "running" })
      break
    case "tool.completed":
    case "tool.failed": {
      const tool = acc.tools.get(event.toolCallId)
      if (tool !== undefined) {
        acc.tools.set(event.toolCallId, { ...tool, status: event.type === "tool.failed" ? "failed" : "completed" })
      }
      break
    }
    default:
      break
  }
  return acc
}

export const buildReplay = <E, R>(
  session: Session,
  events: Stream.Stream<SessionEvent, E, R>
): Effect.Effect<Replay, E, R> =>
  events.pipe(
    Stream.runFold(
      (): Accumulator => ({ conversation: [], terminal: new Map(), files: [], tools: new Map(), plan: [], steps: 0 }),
      step
    ),
    Effect.map((acc) => ({
      title: session.title ?? "Untitled session",
      subagentOf: session.parentSessionId,
      conversation: acc.conversation,
      terminal: [...acc.terminal.values()],
      files: acc.files,
      tools: [...acc.tools.values()],
      plan: acc.plan,
      timeline: { start: acc.start, end: acc.end, steps: acc.steps },
      panes: [
        "conversation" as const,
        ...(session.capabilities.commandEvents ? ["terminal" as const] : []),
        ...(session.capabilities.fileEvents ? ["files" as const] : []),
        ...(session.capabilities.toolCalls ? ["tools" as const] : []),
        ...(session.capabilities.reasoning ? ["reasoning" as const] : [])
      ]
    }))
  )

/** Open any session by ID and build its replay. */
export const replaySession = (id: string): Effect.Effect<Replay, BridgeError, Bridge> =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const { session } = yield* bridge.sessions.get(id)
    return yield* buildReplay(session, bridge.sessions.events(id))
  })

/** Plain-text rendering of a replay, e.g. for terminals or snapshots. */
export const renderReplay = (replay: Replay): string => {
  const lines = [`# ${replay.title}`, ""]
  lines.push("## Conversation")
  for (const entry of replay.conversation) {
    if (entry.role === "user" || entry.role === "agent") lines.push(`${entry.role}: ${entry.text}`)
  }
  lines.push("", "## Terminal")
  for (const entry of replay.terminal) lines.push(`$ ${entry.command}  → ${entry.outcome}`)
  lines.push("", "## Files")
  for (const entry of replay.files) lines.push(`${entry.change} ${entry.path}`)
  return lines.join("\n")
}
