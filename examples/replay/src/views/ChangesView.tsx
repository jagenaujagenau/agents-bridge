import type { EventId, SessionEvent } from "@agentbridge/schema"
import { useMemo, useState } from "react"
import { DiffViewer } from "../components/DiffViewer.tsx"
import { diffStat } from "../replay/files.ts"
import { indexOfId, type ReplaySession } from "../replay/model.ts"
import type { Action } from "../playback/reducer.ts"
import type { ReviewState } from "../review/ReviewStore.ts"

/** What exactly changed (GOAL §23), grouped by chapter (default) or by file. */

type Change = { readonly event: SessionEvent; readonly path: string; readonly additions: number; readonly deletions: number; readonly hasDiff: boolean }
type Group = { readonly key: string; readonly title: string; readonly files: ReadonlyArray<{ path: string; changes: Array<Change> }> }

interface Props {
  readonly replay: ReplaySession
  readonly selected: string | undefined
  readonly dispatch: (action: Action) => void
  readonly review: ReviewState
  readonly toggleReview: (kind: "files", id: string) => void
}

export const ChangesView = ({ replay, selected, dispatch, review, toggleReview }: Props) => {
  const [grouping, setGrouping] = useState<"chapter" | "file">("chapter")
  const [groupKey, setGroupKey] = useState<string | undefined>()

  const changes = useMemo(() =>
    replay.events.flatMap((event): Array<Change> => {
      if (event.type !== "file.created" && event.type !== "file.changed" && event.type !== "file.deleted") return []
      const hasDiff = event.type !== "file.deleted" && event.diff !== undefined
      const stat = hasDiff ? diffStat(event.diff!) : { additions: 0, deletions: 0 }
      return [{ event, path: replay.eventIndex.fileByEvent.get(event.id)!, hasDiff, ...stat }]
    }), [replay])

  const groups = useMemo((): ReadonlyArray<Group> => {
    const byFile = (list: ReadonlyArray<Change>) => {
      const files = new Map<string, Array<Change>>()
      for (const c of list) {
        const entry = files.get(c.path)
        if (entry === undefined) files.set(c.path, [c])
        else entry.push(c)
      }
      return [...files].map(([path, changes]) => ({ path, changes }))
    }
    if (grouping === "file") return [{ key: "all", title: "All files", files: byFile(changes).sort((a, b) => a.path.localeCompare(b.path)) }]
    // One pass: each change goes to the chapter of its scene.
    const byChapter = new Map<string, Array<Change>>()
    for (const c of changes) {
      const chapterId = replay.scenes[indexOfId(replay.eventIndex.sceneByEvent.get(c.event.id)!)]!.chapterId
      const list = byChapter.get(chapterId)
      if (list === undefined) byChapter.set(chapterId, [c])
      else list.push(c)
    }
    return replay.chapters.flatMap((chapter) => {
      const own = byChapter.get(chapter.id)
      return own === undefined ? [] : [{ key: chapter.id, title: `${chapter.index + 1}. ${chapter.title}`, files: byFile(own) }]
    })
  }, [replay, changes, grouping])

  const changedFiles = [...replay.files.values()].filter((f) => f.changeCount > 0)
  const reviewedCount = changedFiles.filter((f) => review.reviewedFiles.has(f.path)).length
  const group = groups.find((g) => g.key === groupKey && g.files.some((f) => f.path === selected)) ??
    groups.find((g) => g.files.some((f) => f.path === selected))
  const entry = group?.files.find((f) => f.path === selected)

  if (changes.length === 0) return <div className="empty">No file changes were recorded in this session.</div>

  return (
    <div className="changes">
      <nav className="changes__list">
        <div className="changes__bar">
          <span className="progress">{reviewedCount} / {changedFiles.length} changed files reviewed</span>
          <div className="segmented">
            <button className={grouping === "chapter" ? "is-on" : ""} onClick={() => setGrouping("chapter")}>By chapter</button>
            <button className={grouping === "file" ? "is-on" : ""} onClick={() => setGrouping("file")}>By file</button>
          </div>
        </div>
        {groups.map((g) => (
          <section key={g.key}>
            {grouping === "chapter" && <h3>{g.title}</h3>}
            {g.files.map(({ path, changes }) => {
              const add = changes.reduce((n, c) => n + c.additions, 0)
              const del = changes.reduce((n, c) => n + c.deletions, 0)
              const isOn = selected === path && group?.key === g.key
              return (
                <div key={path} className={`changes__file ${isOn ? "is-on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={review.reviewedFiles.has(path)}
                    onChange={() => toggleReview("files", path)}
                    aria-label={`Mark ${path} reviewed`}
                  />
                  <button
                    onClick={() => {
                      setGroupKey(g.key)
                      dispatch({ type: "selectFile", path })
                    }}
                  >
                    <span className="mono clip">{path}</span>
                    <span className="stat">
                      {changes.some((c) => c.hasDiff)
                        ? <><span className="add">+{add}</span> <span className="del">−{del}</span></>
                        : <span className="muted">no diff</span>}
                    </span>
                  </button>
                </div>
              )
            })}
          </section>
        ))}
      </nav>
      <div className="changes__diffs">
        {entry === undefined
          ? <p className="muted">Select a file to see its changes.</p>
          : entry.changes.map((c) => (
            <ChangeBlock key={c.event.id} replay={replay} change={c} onOpen={(id) => dispatch({ type: "openEvent", eventId: id })} />
          ))}
      </div>
    </div>
  )
}

const ChangeBlock = ({ replay, change, onOpen }: { replay: ReplaySession; change: Change; onOpen: (id: EventId) => void }) => {
  const scene = replay.scenes[indexOfId(replay.eventIndex.sceneByEvent.get(change.event.id)!)]!
  const e = change.event
  return (
    <article className="change">
      <header>
        <span className="tag">{e.type.replace("file.", "")}</span>
        <button className="link" onClick={() => onOpen(e.id)}>in “{scene.title}” →</button>
      </header>
      {e.type === "file.deleted"
        ? <p className="muted">Deleted.</p>
        : <DiffViewer diff={(e as { diff?: string }).diff} path={change.path} />}
    </article>
  )
}
