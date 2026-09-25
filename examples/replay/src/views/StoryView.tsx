import { type EventId, plainText, type SessionEvent } from "@agentbridge/schema"
import { useEffect, useMemo, useRef, useState } from "react"
import { CodeMap } from "../components/CodeMap.tsx"
import { DiffViewer } from "../components/DiffViewer.tsx"
import { EvidencePanel } from "../components/EvidencePanel.tsx"
import { describeEvent, formatDate, formatDuration } from "../components/format.ts"
import { Terminal } from "../components/Terminal.tsx"
import { ToolInspector } from "../components/ToolInspector.tsx"
import { basename, normalizePath } from "../replay/files.ts"
import { type ChapterId, indexOfId, type ReplayChapter, type ReplayScene, type ReplaySession, type SceneId } from "../replay/model.ts"
import type { Action, PlaybackState, ReplayCursor } from "../playback/reducer.ts"
import { reviewKey, type ReviewState } from "../review/ReviewStore.ts"
import type { JevStatus } from "./SessionView.tsx"
import type { TurnClaims } from "../replay/claims.ts"

interface Props {
  readonly replay: ReplaySession
  readonly state: PlaybackState
  readonly cursor: ReplayCursor | undefined
  readonly dispatch: (action: Action) => void
  readonly review: ReviewState
  readonly toggleReview: (kind: "chapters" | "scenes" | "files", id: string) => void
  readonly inspect: (eventId: EventId) => void
  readonly jev: JevStatus
}

const kindLabel: Record<ReplayChapter["kind"], string> = {
  exploration: "Exploration",
  implementation: "Implementation",
  validation: "Validation",
  debugging: "Debugging",
  other: "Other"
}

const isFileChange = (e: SessionEvent | undefined) =>
  e !== undefined && (e.type === "file.created" || e.type === "file.changed" || e.type === "file.deleted")

export const StoryView = ({ replay, state, cursor, dispatch, review, toggleReview, inspect, jev }: Props) => {
  const [mapFull, setMapFull] = useState(false)
  const scene = cursor !== undefined && state.started ? replay.scenes[indexOfId(cursor.sceneId)] : undefined
  const current = cursor !== undefined ? replay.eventIndex.eventById.get(cursor.eventId) : undefined
  const active = useMemo(() => new Set(scene?.filePaths ?? []), [scene])
  const pulse = state.started && current !== undefined ? replay.eventIndex.fileByEvent.get(current.id) : undefined

  const sceneRefs = useRef(new Map<SceneId, HTMLElement>())
  useEffect(() => {
    if (scene === undefined) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    sceneRefs.current.get(scene.id)?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" })
  }, [scene])

  const open = (eventId: EventId) => dispatch({ type: "openEvent", eventId })

  return (
    <div className={`story ${mapFull ? "is-map-full" : ""}`}>
      <div className="story__narrative">
        <Overview replay={replay} dispatch={dispatch} started={state.started} jev={jev} />
        <ol className="chapters">
          {replay.chapters.map((chapter) => (
            <ChapterBlock
              key={chapter.id}
              replay={replay}
              chapter={chapter}
              currentScene={scene}
              cursorSequence={current?.sequence ?? -1}
              dispatch={dispatch}
              review={review}
              toggleReview={toggleReview}
              sceneRefs={sceneRefs.current}
            />
          ))}
        </ol>
      </div>

      <aside className="story__stage">
        <div className="stage__map">
          <div className="stage__bar">
            <span className="eyebrow">Code map · {replay.files.size} files</span>
            <span className="legend">
              <i className="legend__active" /> in scene <i className="legend__changed" /> changed
            </span>
            <select
              className="filepick"
              aria-label="Select a file"
              value={state.selectedFile ?? ""}
              onChange={(e) => dispatch({ type: "selectFile", path: e.target.value === "" ? undefined : e.target.value })}
            >
              <option value="">Files…</option>
              {[...replay.files.keys()].sort().map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button className="ghost" onClick={() => setMapFull(!mapFull)} aria-pressed={mapFull}>
              {mapFull ? "Exit full map" : "Full map"}
            </button>
          </div>
          <CodeMap
            replay={replay}
            active={active}
            dim={scene !== undefined}
            pulse={pulse}
            pulseKey={state.index}
            selected={state.selectedFile}
            onSelect={(path) => dispatch({ type: "selectFile", path })}
          />
        </div>
        {state.selectedFile !== undefined && (
          <FileCard
            replay={replay}
            path={state.selectedFile}
            reviewed={review.reviewedFiles.has(state.selectedFile)}
            onToggleReviewed={() => toggleReview("files", state.selectedFile!)}
            dispatch={dispatch}
          />
        )}
        {!mapFull && (
          <div className="stage__detail">
            <div className="tabs" role="tablist">
              {(["evidence", "diff", "terminal", "tool"] as const).map((d) => (
                <button
                  key={d}
                  role="tab"
                  aria-selected={state.detail === d}
                  className={state.detail === d ? "is-on" : ""}
                  onClick={() => dispatch({ type: "detail", detail: d })}
                >
                  {d[0]!.toUpperCase() + d.slice(1)}
                  <kbd>{d === "tool" ? "" : d[0]!.toUpperCase()}</kbd>
                </button>
              ))}
            </div>
            <div className="stage__content">
              {scene === undefined || current === undefined
                ? <p className="muted">Press play or pick a chapter to start the walkthrough.</p>
                : state.detail === "evidence"
                ? <EvidencePanel replay={replay} scene={scene} onOpen={open} onInspect={inspect} />
                : state.detail === "diff"
                ? <SceneDiff replay={replay} scene={scene} current={current} selected={state.selectedFile} />
                : state.detail === "terminal"
                ? (
                  <Terminal
                    replay={replay}
                    scene={scene}
                    cursorSequence={current.sequence}
                    onSeek={(id) => dispatch({ type: "seekEvent", eventId: id })}
                  />
                )
                : <ToolInspector replay={replay} eventId={current.id} onSeek={(id) => dispatch({ type: "seekEvent", eventId: id })} />}
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

const Overview = (
  { replay, dispatch, started, jev }: {
    replay: ReplaySession
    dispatch: (a: Action) => void
    started: boolean
    jev: JevStatus
  }
) => {
  const { session, stats } = replay
  const prompt = replay.events.find((e) => e.type === "user.message")
  const [showWarnings, setShowWarnings] = useState(false)
  const outcomes = new Set(stats.checks.map((c) => c.outcome))
  const verdict = stats.checks.length === 0
    ? "none"
    : outcomes.has("failed")
    ? "failing"
    : outcomes.has("unknown")
    ? "unclear"
    : "passed"
  return (
    <header className="overview">
      <p className="eyebrow">
        {session.harness.name}
        {session.agentLabel !== undefined ? ` · ${session.agentLabel}` : ""}
        {session.startedAt !== undefined ? ` · ${formatDate(session.startedAt)}` : ""}
        {session.projectPath !== undefined ? ` · ${session.projectPath}` : ""}
      </p>
      <h1>{replay.title}</h1>
      <p className="lede">{replay.summary}</p>
      {prompt?.type === "user.message" && (
        <blockquote className="prompt">
          <span className="eyebrow">Asked</span>
          <p>{plainText(prompt.content)}</p>
        </blockquote>
      )}
      <dl className="stats">
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(stats.durationMs)}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{replay.events.length}</dd>
        </div>
        <div>
          <dt>Files read</dt>
          <dd>{stats.filesRead}</dd>
        </div>
        <div>
          <dt>Changed</dt>
          <dd>{stats.filesChanged}</dd>
        </div>
        <div>
          <dt>Commands</dt>
          <dd>
            {stats.commands}
            {stats.failedCommands > 0 && <small className="is-failed"> {stats.failedCommands} failed</small>}
            {stats.inspections > 0 && (
              <small className="muted">
                {" "}+{stats.inspections} inspection{stats.inspections === 1 ? "" : "s"}
                {stats.failedInspections > 0 ? `, ${stats.failedInspections} failed` : ""}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>Checks at last run</dt>
          <dd className={verdict === "failing" ? "is-failed" : verdict === "passed" ? "is-passed" : ""}>{verdict}</dd>
        </div>
      </dl>
      <Briefing replay={replay} dispatch={dispatch} />
      <JevNote jev={jev} hidden={replay.checksToJudge.length} />
      <ReplySummary replay={replay} />
      {replay.warnings.length > 0 && (
        <div className="warnings">
          <button className="link" onClick={() => setShowWarnings(!showWarnings)}>
            {replay.warnings.length} compatibility warning{replay.warnings.length === 1 ? "" : "s"}
          </button>
          {showWarnings && (
            <ul>
              {replay.warnings.map((w, i) => (
                <li key={i}>
                  <span className="mono">{w.code}</span> {w.message}
                  {w.count !== undefined ? ` (×${w.count})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {session.capabilities.fileEvents === false && (
        <p className="muted">This harness does not record file events, so the map may be empty.</p>
      )}
      {!started && (
        <button className="primary" onClick={() => dispatch({ type: "play" })}>
          ▶ Start walkthrough <kbd>Space</kbd>
        </button>
      )}
    </header>
  )
}

interface ChapterProps {
  readonly replay: ReplaySession
  readonly chapter: ReplayChapter
  readonly currentScene: ReplayScene | undefined
  readonly cursorSequence: number
  readonly dispatch: (action: Action) => void
  readonly review: ReviewState
  readonly toggleReview: (kind: "chapters" | "scenes" | "files", id: string) => void
  readonly sceneRefs: Map<SceneId, HTMLElement>
}

const ChapterBlock = ({ replay, chapter, currentScene, cursorSequence, dispatch, review, toggleReview, sceneRefs }: ChapterProps) => {
  const isCurrent = currentScene?.chapterId === chapter.id
  const prompt = chapter.promptEventId !== undefined ? replay.eventIndex.eventById.get(chapter.promptEventId) : undefined
  const reviewed = review.reviewedChapters.has(reviewKey(chapter))
  const turn = replay.turns.find((t) => t.promptEventId === chapter.promptEventId)
  const firstPromptId = replay.events.find((e) => e.type === "user.message")?.id
  return (
    <li className={`chapter kind-${chapter.kind} ${isCurrent ? "is-current" : ""}`} id={chapter.id}>
      <div className="chapter__head" onClick={() => dispatch({ type: "seekChapter", chapterId: chapter.id as ChapterId })}>
        <span className="chapter__num">{String(chapter.index + 1).padStart(2, "0")}</span>
        <div>
          <span className={`tag kind-${chapter.kind}`}>{kindLabel[chapter.kind]}</span>
          <h2><button className="plain">{chapter.title}</button></h2>
          {chapter.summary !== undefined && <p className="muted">{chapter.summary}</p>}
        </div>
        <ReviewToggle checked={reviewed} onChange={() => toggleReview("chapters", reviewKey(chapter))} label="chapter" />
      </div>
      {prompt?.type === "user.message" && prompt.id !== firstPromptId && (
        <blockquote className="prompt prompt--small">
          <p>{plainText(prompt.content)}</p>
        </blockquote>
      )}
      {turn !== undefined && <Claims turn={turn} />}
      <ol className="scenes">
        {chapter.sceneIds.map((id) => {
          const scene = replay.scenes[indexOfId(id)]!
          const active = currentScene?.id === id
          return (
            <li
              key={id}
              ref={(el) => {
                if (el !== null) sceneRefs.set(id, el)
                else sceneRefs.delete(id)
              }}
              className={`scene kind-${scene.kind} ${active ? "is-active" : ""} ${scene.outcome !== undefined ? `outcome-${scene.outcome}` : ""}`}
            >
              <div className="scene__head" onClick={() => dispatch({ type: "seekScene", sceneId: id })}>
                <span className="scene__dot" />
                <button className="plain scene__title" aria-current={active ? "step" : undefined}>{scene.title}</button>
                <ReviewToggle
                  checked={review.reviewedScenes.has(reviewKey(scene))}
                  onChange={() => toggleReview("scenes", reviewKey(scene))}
                  label="scene"
                /> 
              </div>
              {active && <SceneNarration replay={replay} scene={scene} cursorSequence={cursorSequence} dispatch={dispatch} />}
            </li>
          )
        })}
      </ol>
    </li>
  )
}

/** The scene's events up to the cursor: the agent's own words plus what it did. */
const SceneNarration = (
  { replay, scene, cursorSequence, dispatch }: {
    replay: ReplaySession
    scene: ReplayScene
    cursorSequence: number
    dispatch: (a: Action) => void
  }
) => {
  const rel = normalizePath(replay.session.projectPath ?? replay.session.workspacePath)
  const shown = scene.eventIds
    .filter((id) => replay.timeline.indexByEvent.has(id))
    .map((id) => replay.eventIndex.eventById.get(id)!)
  return (
    <div className="scene__body">
      {scene.description !== undefined && <pre className="scene__desc">{scene.description}</pre>}
      {scene.filePaths.length > 0 && (
        <div className="scene__files">
          {scene.filePaths.slice(0, 8).map((p) => (
            <button key={p} className="chip" onClick={() => dispatch({ type: "selectFile", path: p })} title={p}>
              {basename(p)}
            </button>
          ))}
          {scene.filePaths.length > 8 && <span className="muted">+{scene.filePaths.length - 8}</span>}
        </div>
      )}
      <button
        className="link scene__jump"
        onClick={() => document.querySelector(".story__stage")?.scrollIntoView({ behavior: "smooth", block: "start" })}
      >
        Show on map &amp; evidence ↓
      </button>
      <ol className="beats">
        {shown.map((e) => {
          const state = e.sequence < cursorSequence ? "past" : e.sequence === cursorSequence ? "now" : "future"
          const voice = e.type === "agent.message" || e.type === "user.message"
          const [glyph, text] = describeEvent(e, rel)
          return (
            <li key={e.id} className={`beat is-${state} ${voice ? "is-voice" : ""}`} onClick={() => dispatch({ type: "seekEvent", eventId: e.id })}>
              <span className="glyph">{glyph}</span>
              <button className="plain" aria-current={state === "now" ? "step" : undefined}>
                {voice ? <span className="voice">{plainText(e.content)}</span> : <span className="clip">{text}</span>}
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Work performed and checks, each line linked to the evidence behind it (AUDIT A). */
const Briefing = ({ replay, dispatch }: { replay: ReplaySession; dispatch: (a: Action) => void }) => {
  const changed = [...replay.files.values()]
    .filter((f) => f.changeCount > 0)
    .sort((a, b) => b.activity - a.activity || a.path.localeCompare(b.path))
  const order = { failed: 0, unknown: 1, passed: 2 } as const
  const checks = [...replay.stats.checks].sort((a, b) => order[a.outcome] - order[b.outcome])
  if (changed.length === 0 && checks.length === 0) return null
  return (
    <div className="briefing">
      {changed.length > 0 && (
        <section>
          <span className="eyebrow">Work performed</span>
          <ul>
            {changed.slice(0, 6).map((f) => (
              <li key={f.path}>
                <button className="plain briefing__row" onClick={() => dispatch({ type: "selectFile", path: f.path })}>
                  <span className="mono clip">{f.path}</span>
                  <span className="stat">
                    {f.additions !== undefined
                      ? <><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></>
                      : `${f.changeCount} change${f.changeCount === 1 ? "" : "s"}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {changed.length > 6 && <p className="muted">and {changed.length - 6} more in Changes</p>}
        </section>
      )}
      {checks.length > 0 && (
        <section>
          <span className="eyebrow">Checks at their last run</span>
          <ul>
            {checks.map((c) => (
              <li key={c.command}>
                <button className="plain briefing__row" onClick={() => dispatch({ type: "seekScene", sceneId: c.lastSceneId })}>
                  <span className="mono clip">{c.command}</span>
                  <span className={`outcome-${c.outcome === "passed" ? "succeeded" : c.outcome === "failed" ? "failed" : "unknown"}`}>
                    {c.outcome === "unknown" ? "unclear" : c.outcome}
                    {c.inferred !== undefined ? " (inferred)" : ""}
                    {c.runs > 1 ? ` · ${c.runs} runs` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** Claims in one closing reply, and any the recorded checks do not support. */
const Claims = ({ turn }: { turn: TurnClaims }) => {
  const said = [
    turn.says.done ? "done" : "not finished",
    ...(turn.says.testsPass ? ["tests pass"] : []),
    ...(turn.says.checksPass ? ["build / type check / lint passes"] : []),
    ...(turn.says.openProblem ? ["a problem remains"] : [])
  ]
  return (
    <div className="claims" title={`Read from the closing reply by ${turn.model}`}>
      <span className="eyebrow">Reply says</span>
      {said.map((s) => <span key={s} className={`chip ${s === "a problem remains" ? "is-failed" : ""}`}>{s}</span>)}
      {turn.conflicts.map((c) => <p key={c} className="claims__conflict">⚠ {c}</p>)}
    </div>
  )
}

/** The overview's account of what the agent said, set against what the session recorded. */
const ReplySummary = ({ replay }: { replay: ReplaySession }) => {
  const last = replay.turns.at(-1)
  if (last === undefined) return null
  const conflicts = replay.turns.flatMap((t) => t.conflicts)
  return (
    <section className="said">
      <span className="eyebrow">What the agent said at the end</span>
      <Claims turn={last} />
      {conflicts.length > last.conflicts.length && (
        <p className="muted">
          {conflicts.length} claim{conflicts.length === 1 ? "" : "s"} across all replies {conflicts.length === 1 ? "is" : "are"} not
          supported by recorded checks; see the chapters marked ⚠.
        </p>
      )}
    </section>
  )
}

/** Where hidden check results stand: judged, being judged, or how to enable judging. */
const JevNote = ({ jev, hidden }: { jev: JevStatus; hidden: number }) => {
  const plural = (n: number) => `${n} check result${n === 1 ? "" : "s"}`
  switch (jev.state) {
    case "judging":
      return <p className="jev">Jev is reading the output of {plural(jev.count)} the shell hid…</p>
    case "done":
      if (jev.total === 0) return null
      if (jev.judged === 0 && jev.failed > 0) {
        return <p className="jev is-failed">Jev could not judge the {plural(jev.total)} the shell hid; see the dev server log.</p>
      }
      return (
        <p className="jev">
          Jev inferred {jev.judged} of {plural(jev.total)} the shell hid, from their recorded output. They are marked
          “inferred”; the rest stay unknown{jev.failed > 0 ? ` (${jev.failed} could not be judged)` : ""}.
        </p>
      )
    case "error":
      return <p className="jev is-failed">Could not judge hidden check results: {jev.message}</p>
    case "off":
      return hidden > 0
        ? (
          <p className="jev muted">
            The shell hid {plural(hidden)} (for example by piping into <code>tail</code>). Start Replay with{" "}
            <code>REPLAY_JEV=1</code> and <code>TYPESAFE_API_KEY</code> to let Jev infer them from their output.
          </p>
        )
        : null
  }
}

const ReviewToggle = ({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) => (
  <label className={`review ${checked ? "is-on" : ""}`} onClick={(e) => e.stopPropagation()} title={`Mark ${label} reviewed`}>
    <input type="checkbox" checked={checked} onChange={onChange} aria-label={`Mark ${label} reviewed`} />
    <span>{checked ? "Reviewed" : "Review"}</span>
  </label>
)

const SceneDiff = (
  { replay, scene, current, selected }: { replay: ReplaySession; scene: ReplayScene; current: SessionEvent; selected?: string | undefined }
) => {
  // Which change is shown, in order: the event under the cursor, the selected file's change in
  // this scene, the scene's latest change so far, then the selected file's latest change anywhere.
  const fileOf = (e: SessionEvent) => replay.eventIndex.fileByEvent.get(e.id)
  const changes = scene.eventIds.map((id) => replay.eventIndex.eventById.get(id)!).filter(isFileChange)
  const upToCursor = changes.filter((e) => e.sequence <= current.sequence)
  const selectedHere = selected !== undefined ? changes.filter((e) => fileOf(e) === selected) : []
  const selectedAnywhere = selected !== undefined
    ? (replay.eventIndex.eventsByFile.get(selected) ?? []).map((id) => replay.eventIndex.eventById.get(id)!).filter(isFileChange)
    : []
  const [target, reason] = isFileChange(current)
    ? [current, "Change at the cursor"]
    : selectedHere.length > 0
    ? [selectedHere.findLast((e) => e.sequence <= current.sequence) ?? selectedHere[0]!, "Selected file, in this scene"]
    : upToCursor.length > 0
    ? [upToCursor.at(-1)!, "Latest change in this scene so far"]
    : changes.length > 0
    ? [changes[0]!, "First change in this scene (after the cursor)"]
    : selectedAnywhere.length > 0
    ? [selectedAnywhere.at(-1)!, "Selected file, last changed outside this scene"]
    : [undefined, ""]
  if (target === undefined) return <p className="muted">No file changes in this scene.</p>
  const path = fileOf(target)!
  return (
    <>
      <p className="eyebrow diff__reason">{reason}</p>
      {target.type === "file.deleted"
        ? <p className="muted">{path} was deleted.</p>
        : <DiffViewer diff={(target as { diff?: string }).diff} path={path} />}
    </>
  )
}

const FileCard = (
  { replay, path, reviewed, onToggleReviewed, dispatch }: {
    replay: ReplaySession
    path: string
    reviewed: boolean
    onToggleReviewed: () => void
    dispatch: (a: Action) => void
  }
) => {
  const file = replay.files.get(path)
  if (file === undefined) return null
  return (
    <div className="filecard">
      <div className="filecard__head">
        <span className="mono">{file.path}</span>
        <button className="ghost" onClick={() => dispatch({ type: "selectFile", path: undefined })} aria-label="Close file">×</button>
      </div>
      <p className="muted">
        {file.readCount} read{file.readCount === 1 ? "" : "s"} · {file.changeCount} change{file.changeCount === 1 ? "" : "s"}
        {file.additions !== undefined && <> · <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></>}
        {file.created ? " · created" : ""}
        {file.deleted ? " · deleted" : ""}
        {file.language !== undefined ? ` · ${file.language}` : ""}
      </p>
      <ul className="filecard__scenes">
        {file.sceneIds.map((id) => (
          <li key={id}>
            <button className="plain" onClick={() => dispatch({ type: "seekScene", sceneId: id })}>
              {replay.scenes[indexOfId(id)]!.title}
            </button>
          </li>
        ))}
      </ul>
      {file.changeCount > 0 && <ReviewToggle checked={reviewed} onChange={onToggleReviewed} label="file" />}
    </div>
  )
}
