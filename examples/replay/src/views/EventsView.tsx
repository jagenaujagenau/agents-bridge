import type { EventId, SessionEvent } from "@agentbridge/schema"
import { useEffect, useMemo, useRef, useState } from "react"
import { describeEvent, formatTime } from "../components/format.ts"
import { ToolInspector } from "../components/ToolInspector.tsx"
import { normalizePath } from "../replay/files.ts"
import { indexOfId, type ReplaySession } from "../replay/model.ts"
import type { Action } from "../playback/reducer.ts"

/** Raw canonical events (GOAL §26), virtualized, with a JSON inspector. */

const ROW = 30

interface Props {
  readonly replay: ReplaySession
  readonly cursorEvent: EventId | undefined
  readonly inspected: EventId | undefined
  readonly dispatch: (action: Action) => void
}

export const EventsView = ({ replay, cursorEvent, inspected, dispatch }: Props) => {
  const [filter, setFilter] = useState("")
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const listRef = useRef<HTMLDivElement>(null)
  const rel = useMemo(() => normalizePath(replay.session.projectPath ?? replay.session.workspacePath), [replay])

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const all = replay.events.map((e) => ({ e, text: describeEvent(e, rel) }))
    return needle === "" ? all : all.filter(({ e, text }) => e.type.includes(needle) || text[1].toLowerCase().includes(needle))
  }, [replay, filter, rel])

  useEffect(() => {
    const el = listRef.current
    if (el === null) return
    const observer = new ResizeObserver(() => setHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Bring the inspected event into view when it changes from elsewhere (deep link, evidence panel).
  useEffect(() => {
    const el = listRef.current
    const i = rows.findIndex((r) => r.e.id === inspected)
    if (el === null || i < 0) return
    if (i * ROW < el.scrollTop || (i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = i * ROW - el.clientHeight / 3
  }, [inspected, rows])

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 10)
  const event = inspected !== undefined ? replay.eventIndex.eventById.get(inspected) : undefined

  return (
    <div className="events">
      <div className="events__list">
        <input
          className="filter"
          placeholder="Filter by type or text…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="events__scroll" ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: rows.length * ROW, position: "relative" }}>
            {rows.slice(first, last).map(({ e, text: [glyph, text] }, k) => (
              <button
                key={e.id}
                className={`events__row ${e.id === inspected ? "is-on" : ""} ${e.id === cursorEvent ? "is-cursor" : ""}`}
                style={{ top: (first + k) * ROW, height: ROW }}
                onClick={() => dispatch({ type: "seekEvent", eventId: e.id, inspect: true })}
              >
                <span className="seq">{e.sequence}</span>
                <span className="time">{formatTime(e.timestamp)}</span>
                <span className="glyph">{glyph}</span>
                <span className="type">{e.type}</span>
                <span className="clip">{text}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="events__inspector">
        {event === undefined
          ? <p className="muted">Select an event to inspect its canonical JSON.</p>
          : <EventInspector replay={replay} event={event} dispatch={dispatch} />}
      </div>
    </div>
  )
}

const EventInspector = ({ replay, event, dispatch }: { replay: ReplaySession; event: SessionEvent; dispatch: (a: Action) => void }) => {
  const [showSource, setShowSource] = useState(false)
  const sceneId = replay.eventIndex.sceneByEvent.get(event.id)
  const scene = sceneId !== undefined ? replay.scenes[indexOfId(sceneId)] : undefined
  const { source, ...canonical } = event
  const isTool = event.type.startsWith("tool.") || (event.parentEventId !== undefined &&
    replay.eventIndex.eventById.get(event.parentEventId)?.type === "tool.started")
  return (
    <div className="inspector">
      <div className="inspector__head">
        <span className="tag">{event.type}</span>
        <span className="muted">#{event.sequence} · {event.certainty}</span>
        {scene !== undefined && (
          <button
            className="link"
            onClick={() => dispatch({ type: "openEvent", eventId: event.id })}
          >
            Show in story: {scene.title} →
          </button>
        )}
      </div>
      <pre className="json">{JSON.stringify(canonical, null, 2)}</pre>
      <button className="link" onClick={() => setShowSource(!showSource)}>
        {showSource ? "Hide" : "Show"} source reference
      </button>
      {showSource && <pre className="json">{JSON.stringify(source, null, 2)}</pre>}
      {isTool && (
        <>
          <h4>Tool call</h4>
          <ToolInspector replay={replay} eventId={event.id} onSeek={(id) => dispatch({ type: "seekEvent", eventId: id, inspect: true })} />
        </>
      )}
    </div>
  )
}
