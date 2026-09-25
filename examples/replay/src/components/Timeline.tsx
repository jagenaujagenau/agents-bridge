import { memo, useMemo } from "react"
import type { ReplaySession } from "../replay/model.ts"

/**
 * Presentation timeline: chapters as segments sized by how many steps they hold,
 * not by wall-clock time, so a 40-second command does not dwarf an instant edit.
 */

interface Props {
  readonly replay: ReplaySession
  readonly index: number
  readonly onSeek: (index: number) => void
}

export const Timeline = memo(function Timeline({ replay, index, onSeek }: Props) {
  const entries = replay.timeline.entries
  const total = Math.max(1, entries.length)
  const { segments, failures, sceneTicks } = useMemo(() => {
    const segments = replay.chapters.flatMap((chapter) => {
      const start = replay.timeline.firstIndexByChapter.get(chapter.id)
      if (start === undefined) return []
      let end = start
      while (end + 1 < entries.length && entries[end + 1]!.chapterId === chapter.id) end++
      return [{ chapter, start, count: end - start + 1 }]
    })
    const failures = entries.flatMap((entry, i) => {
      const e = replay.eventIndex.eventById.get(entry.eventId)
      return (e?.type === "command.completed" && e.outcome === "failed") || e?.type === "tool.failed" ? [i] : []
    })
    const sceneTicks = [...replay.timeline.firstIndexByScene.values()]
    return { segments, failures, sceneTicks }
  }, [replay, entries])

  const seekFrom = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    onSeek(Math.min(total - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * total))))
  }
  const pct = (i: number) => `${(i / total) * 100}%`
  const current = entries[index]

  return (
    <div
      className="timeline"
      onClick={seekFrom}
      role="slider"
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={total - 1}
      aria-valuenow={index}
      tabIndex={0}
      onKeyDown={(event) => {
        // Arrow keys step through the global shortcuts; Home and End jump to the ends.
        if (event.key === "Home") onSeek(0)
        else if (event.key === "End") onSeek(total - 1)
        else return
        event.preventDefault()
      }}
    >
      {segments.map(({ chapter, start, count }) => (
        <div
          key={chapter.id}
          className={`timeline__segment kind-${chapter.kind} ${current?.chapterId === chapter.id ? "is-current" : ""}`}
          style={{ left: pct(start), width: pct(count) }}
          title={`${chapter.index + 1}. ${chapter.title}`}
        />
      ))}
      {sceneTicks.map((i) => <div key={i} className="timeline__tick" style={{ left: pct(i) }} />)}
      {failures.map((i) => <div key={i} className="timeline__failure" style={{ left: pct(i) }} />)}
      <div className="timeline__progress" style={{ width: pct(index + 1) }} />
      <div className="timeline__head" style={{ left: pct(index + 0.5) }} />
    </div>
  )
})
