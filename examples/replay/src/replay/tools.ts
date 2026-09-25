import type { SessionEvent, ToolKind, ToolStarted } from "@agentbridge/schema"

type Json = Exclude<ToolStarted["input"], undefined>

/**
 * A tool call as the session finally described it: `tool.started` with every later
 * `tool.updated` folded in (omitted fields unchanged, `input: null` clears input).
 * Raw events are never modified; this is a derived view.
 */
export interface ToolProjection {
  readonly started: ToolStarted
  readonly name: string
  readonly kind: ToolKind
  readonly input?: Json | undefined
}

export const projectTool = (started: ToolStarted, events: Iterable<SessionEvent>): ToolProjection => {
  let name = started.name
  let kind = started.kind
  let input: Json | undefined = started.input
  for (const e of events) {
    if (e.type !== "tool.updated" || e.toolCallId !== started.toolCallId) continue
    if (e.name !== undefined) name = e.name
    if (e.kind !== undefined) kind = e.kind
    if ("input" in e) input = e.input === null ? undefined : e.input
  }
  return { started, name, kind, input }
}
