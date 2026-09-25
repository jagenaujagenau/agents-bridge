import type { EventId, SessionEvent } from "@agentbridge/schema"
import { diffStat } from "../replay/files.ts"
import type { ReplayScene, ReplaySession } from "../replay/model.ts"

/** The evidence behind one scene (GOAL §22). Every row opens the event it summarizes. */

interface Props {
  readonly replay: ReplaySession
  readonly scene: ReplayScene
  readonly onOpen: (eventId: EventId) => void
  readonly onInspect: (eventId: EventId) => void
}

export const EvidencePanel = ({ replay, scene, onOpen, onInspect }: Props) => {
  const events = scene.eventIds.map((id) => replay.eventIndex.eventById.get(id)!)
  const path = (e: SessionEvent) => replay.eventIndex.fileByEvent.get(e.id)!

  const changes = new Map<string, { first: EventId; additions: number; deletions: number; hasDiff: boolean }>()
  const reads = new Map<string, EventId>()
  for (const e of events) {
    if (e.type === "file.read" && !reads.has(path(e))) reads.set(path(e), e.id)
    if (e.type === "file.created" || e.type === "file.changed" || e.type === "file.deleted") {
      const entry = changes.get(path(e)) ?? { first: e.id, additions: 0, deletions: 0, hasDiff: false }
      if (e.type !== "file.deleted" && e.diff !== undefined) {
        const stat = diffStat(e.diff)
        entry.additions += stat.additions
        entry.deletions += stat.deletions
        entry.hasDiff = true
      }
      changes.set(path(e), entry)
    }
  }
  for (const p of changes.keys()) reads.delete(p)

  const outcomes = new Map<string, SessionEvent>()
  for (const e of events) if (e.type === "command.completed") outcomes.set(e.commandId, e)
  const commands = events.flatMap((e) => (e.type === "command.started" ? [e] : []))
  const tools = new Map<string, number>()
  for (const e of events) if (e.type === "tool.started") tools.set(e.name, (tools.get(e.name) ?? 0) + 1)
  const commits = events.flatMap((e) => (e.type === "git.commit" ? [e] : []))

  return (
    <div className="evidence">
      {changes.size > 0 && (
        <section>
          <h4>Changed</h4>
          {[...changes].map(([p, c]) => (
            <button key={p} className="evidence__row" onClick={() => onOpen(c.first)}>
              <span className="mono">{p}</span>
              <span className="stat">
                {c.hasDiff ? <><span className="add">+{c.additions}</span> <span className="del">−{c.deletions}</span></> : "—"}
              </span>
            </button>
          ))}
        </section>
      )}
      {reads.size > 0 && (
        <section>
          <h4>Read</h4>
          {[...reads].map(([p, id]) => (
            <button key={p} className="evidence__row" onClick={() => onOpen(id)}>
              <span className="mono">{p}</span>
            </button>
          ))}
        </section>
      )}
      {commands.length > 0 && (
        <section>
          <h4>Commands</h4>
          {commands.map((c) => {
            const done = outcomes.get(c.commandId)
            const outcome = done?.type === "command.completed" ? done.outcome : "unknown"
            return (
              <button key={c.id} className="evidence__row" onClick={() => onOpen(c.id)}>
                <span className="mono clip">{c.command.split("\n")[0]}</span>
                <span className={`outcome outcome-${outcome}`}>
                  {outcome === "succeeded" ? "✓" : outcome === "failed" ? "✗" : "?"}
                </span>
              </button>
            )
          })}
        </section>
      )}
      {commits.length > 0 && (
        <section>
          <h4>Commits</h4>
          {commits.map((c) => (
            <button key={c.id} className="evidence__row" onClick={() => onInspect(c.id)}>
              <span className="mono">{c.commit?.slice(0, 7) ?? "commit"}</span>
              <span className="clip">{c.message ?? ""}</span>
            </button>
          ))}
        </section>
      )}
      {tools.size > 0 && (
        <section>
          <h4>Tools</h4>
          <p className="tools">
            {[...tools].map(([name, n]) => <span key={name} className="chip">{name} × {n}</span>)}
          </p>
        </section>
      )}
      <button className="link" onClick={() => onInspect(scene.eventIds[0]!)}>
        Inspect all {scene.eventIds.length} events →
      </button>
    </div>
  )
}
