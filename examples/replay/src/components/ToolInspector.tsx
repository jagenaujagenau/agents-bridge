import type { EventId, SessionEvent, ToolStarted } from "@agentbridge/schema"
import type { ReplaySession } from "../replay/model.ts"
import { projectTool } from "../replay/tools.ts"
import { describeEvent, formatDuration } from "./format.ts"

/** Generic canonical tool data (GOAL §25). Also a lens for debugging Bridge normalization. */

/** Tool calls and their related events, indexed once per session rather than scanned per render. */
const toolIndexes = new WeakMap<ReplaySession, { starts: Map<string, ToolStarted>; related: Map<string, Array<SessionEvent>> }>()
const indexTools = (replay: ReplaySession) => {
  let index = toolIndexes.get(replay)
  if (index === undefined) {
    const starts = new Map<string, ToolStarted>()
    const related = new Map<string, Array<SessionEvent>>()
    const add = (key: string, e: SessionEvent) => {
      const list = related.get(key)
      if (list === undefined) related.set(key, [e])
      else list.push(e)
    }
    for (const e of replay.events) {
      if (e.type === "tool.started") starts.set(e.toolCallId, e)
      else if ("toolCallId" in e) add(`call:${e.toolCallId}`, e)
      if (e.parentEventId !== undefined) add(`parent:${e.parentEventId}`, e)
    }
    index = { starts, related }
    toolIndexes.set(replay, index)
  }
  return index
}

const toolOf = (replay: ReplaySession, event: SessionEvent): ToolStarted | undefined => {
  if (event.type === "tool.started") return event
  const byCall = "toolCallId" in event ? indexTools(replay).starts.get(event.toolCallId) : undefined
  if (byCall !== undefined) return byCall
  const parent = event.parentEventId !== undefined ? replay.eventIndex.eventById.get(event.parentEventId) : undefined
  return parent?.type === "tool.started" ? parent : undefined
}

const Json = ({ value }: { readonly value: unknown }) => (
  <pre className="json">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
)

export const ToolInspector = (
  { replay, eventId, onSeek }: { readonly replay: ReplaySession; readonly eventId: EventId; readonly onSeek: (id: EventId) => void }
) => {
  const event = replay.eventIndex.eventById.get(eventId)
  const tool = event === undefined ? undefined : toolOf(replay, event)
  if (tool === undefined) return <p className="muted">The current event is not part of a tool call.</p>

  const { related: index } = indexTools(replay)
  const related = [
    ...new Set([...(index.get(`call:${tool.toolCallId}`) ?? []), ...(index.get(`parent:${tool.id}`) ?? [])])
  ].sort((a, b) => a.sequence - b.sequence)
  const projection = projectTool(tool, related)
  const end = related.find((e) => e.type === "tool.completed" || e.type === "tool.failed")
  const derived = related.filter((e) => e.parentEventId === tool.id)
  const duration = end?.timestamp !== undefined && tool.timestamp !== undefined
    ? Date.parse(end.timestamp) - Date.parse(tool.timestamp)
    : undefined

  return (
    <div className="inspector">
      <dl className="facts">
        <dt>Tool</dt>
        <dd className="mono">{projection.name}</dd>
        <dt>Kind</dt>
        <dd>{projection.kind}</dd>
        <dt>Status</dt>
        <dd className={end?.type === "tool.failed" ? "is-failed" : ""}>
          {end === undefined ? "no result recorded" : end.type === "tool.failed" ? "failed" : "completed"}
        </dd>
        <dt>Duration</dt>
        <dd>{formatDuration(duration)}</dd>
      </dl>
      {projection.input !== undefined && (
        <>
          <h4>Input</h4>
          <Json value={projection.input} />
        </>
      )}
      {related.some((e) => e.type === "tool.updated") && (
        <p className="muted">Name, kind and input include later tool.updated events; the Events view keeps each as recorded.</p>
      )}
      {end?.type === "tool.completed" && end.output !== undefined && (
        <>
          <h4>Output</h4>
          <Json value={end.output} />
        </>
      )}
      {end?.type === "tool.failed" && (
        <>
          <h4>Error</h4>
          <Json value={end.message} />
        </>
      )}
      {derived.length > 0 && (
        <>
          <h4>Derived events</h4>
          <ul className="event-list">
            {derived.map((e) => {
              const [glyph, text] = describeEvent(e)
              return (
                <li key={e.id}>
                  <button className="plain" onClick={() => onSeek(e.id)}>
                    <span className="glyph">{glyph}</span> {e.type} <span className="muted">{text}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
