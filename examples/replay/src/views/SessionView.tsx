import type { EventId } from "@agentbridge/schema"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { fetchJudgments, fetchReplay } from "../app/api.ts"
import { deriveReplay } from "../replay/derive.ts"
import { formatRoute, type Route, type View } from "../app/routes.ts"
import { formatTime } from "../components/format.ts"
import { Timeline } from "../components/Timeline.tsx"
import { type ChapterId, indexOfId, type ReplaySession, type SceneId } from "../replay/model.ts"
import { cursorOf, initialState, makeReducer, type Speed } from "../playback/reducer.ts"
import { useShortcuts } from "../playback/shortcuts.ts"
import { Tour, tourSeen } from "../components/Tour.tsx"
import { SESSION_TOUR_KEY, sessionTour } from "./sessionTour.tsx"
import { reviewKey, useReview } from "../review/ReviewStore.ts"
import { ChangesView } from "./ChangesView.tsx"
import { EventsView } from "./EventsView.tsx"
import { StoryView } from "./StoryView.tsx"

type SessionRoute = Extract<Route, { page: "session" }>

/** Progress of optional judgments of hidden check results. */
export type JevStatus =
  | { readonly state: "off" }
  | { readonly state: "judging"; readonly count: number }
  | { readonly state: "done"; readonly judged: number; readonly total: number; readonly failed: number }
  | { readonly state: "error"; readonly message: string }

export const SessionView = ({ route }: { readonly route: SessionRoute }) => {
  const [replay, setReplay] = useState<ReplaySession | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [jev, setJev] = useState<JevStatus>({ state: "off" })
  useEffect(() => {
    let live = true
    fetchReplay(route.id).then(
      (deterministic) => {
        if (!live) return
        // The deterministic story shows at once; judgments, if enabled, refine it afterwards.
        setReplay(deterministic)
        const { session, events, warnings } = deterministic
        const firstRound = [
          ...deterministic.checksToJudge,
          ...deterministic.repliesToJudge,
          ...deterministic.commandsToClassify
        ]
        if (firstRound.length === 0) return
        setJev({ state: "judging", count: deterministic.checksToJudge.length + deterministic.commandsToClassify.length })
        const run = async () => {
          const first = await fetchJudgments(
            route.id,
            deterministic.checksToJudge,
            deterministic.repliesToJudge,
            deterministic.commandsToClassify
          )
          if (!first.enabled) return undefined
          let options = { judgments: first.judgments, replies: first.replies, commandKinds: first.commandKinds }
          let refined = deriveReplay(session, events, warnings, options)
          let failed = first.failed
          // Commands newly identified as checks may have hidden results of their own: one more round.
          if (refined.checksToJudge.length > 0) {
            const second = await fetchJudgments(route.id, refined.checksToJudge)
            options = { ...options, judgments: new Map([...options.judgments, ...second.judgments]) }
            refined = deriveReplay(session, events, warnings, options)
            failed += second.failed
          }
          return { refined, options, failed }
        }
        run().then(
          (result) => {
            if (!live) return
            if (result === undefined) return setJev({ state: "off" })
            setReplay(result.refined)
            const total = deterministic.checksToJudge.length + [...result.options.commandKinds.values()]
              .filter((k) => k.kind !== "not_a_check").length
            setJev({ state: "done", judged: result.options.judgments.size, total, failed: result.failed })
          },
          (e: unknown) => live && setJev({ state: "error", message: String((e as Error).message ?? e) })
        )
      },
      (e: unknown) => live && setError(String((e as Error).message ?? e))
    )
    return () => {
      live = false
    }
  }, [route.id])

  if (error !== undefined) {
    return (
      <main className="loading">
        <p className="error">Could not open {route.id}: {error}</p>
        <a href="#/">← All sessions</a>
      </main>
    )
  }
  if (replay === undefined) return <main className="loading"><p className="muted">Reconstructing {route.id}…</p></main>
  return <Loaded replay={replay} route={route} jev={jev} />
}

const speeds: ReadonlyArray<Speed> = [0.5, 1, 2, 4, 8]

const Loaded = (
  { replay, route, jev }: { readonly replay: ReplaySession; readonly route: SessionRoute; readonly jev: JevStatus }
) => {
  const reducer = useMemo(() => makeReducer(replay), [replay])
  const [state, dispatch] = useReducer(reducer, route.view, initialState)
  const { review, toggle } = useReview(replay.session.id)
  // First visit to any session opens the tour; the Tour button replays it on the Story view.
  const [touring, setTouring] = useState(() => !tourSeen.get(SESSION_TOUR_KEY))
  const closeTour = useCallback(() => {
    tourSeen.set(SESSION_TOUR_KEY)
    setTouring(false)
  }, [])
  const startTour = () => {
    dispatch({ type: "view", view: "story" })
    // After the Story view has rendered, so every step finds its target.
    setTimeout(() => setTouring(true), 0)
  }
  const cursor = cursorOf(replay, state.index)
  const written = useRef<string | undefined>(undefined)

  // Route → state, on load and whenever the hash changes from outside (links, back/forward).
  useEffect(() => {
    if (formatRoute(route) === written.current) return
    dispatch({ type: "view", view: route.view })
    if (route.scene !== undefined) dispatch({ type: "seekScene", sceneId: route.scene as SceneId })
    else if (route.chapter !== undefined) dispatch({ type: "seekChapter", chapterId: route.chapter as ChapterId })
    if (route.event !== undefined) dispatch({ type: "seekEvent", eventId: route.event as EventId, inspect: true })
    if (route.file !== undefined) dispatch({ type: "selectFile", path: route.file })
  }, [route])

  // State → route. Only scene-level changes reach the URL, so playback does not flood history.
  const sceneId = state.started ? cursor?.sceneId : undefined
  useEffect(() => {
    const next = formatRoute({
      page: "session",
      id: replay.session.id,
      view: state.view,
      scene: state.view === "story" ? sceneId : undefined,
      event: state.view === "events" ? state.inspected : undefined,
      file: state.view !== "events" ? state.selectedFile : undefined
    })
    if (next !== window.location.hash) {
      written.current = next
      // Playback only updates the address; a deliberate move is a step Back can undo.
      if (state.status === "playing") window.history.replaceState(null, "", next)
      else window.history.pushState(null, "", next)
    }
  }, [replay, state.view, sceneId, state.inspected, state.selectedFile, state.status])

  // Playback clock: presentation time, not source time.
  useEffect(() => {
    if (state.status !== "playing") return
    const entry = replay.timeline.entries[state.index]
    const timer = window.setTimeout(() => dispatch({ type: "tick" }), (entry?.dwellMs ?? 800) / state.speed)
    return () => window.clearTimeout(timer)
  }, [replay, state.status, state.index, state.speed])

  const inspect = useCallback((eventId: EventId) => {
    dispatch({ type: "seekEvent", eventId, inspect: true })
    dispatch({ type: "view", view: "events" })
  }, [])
  const focusFile = useCallback(() => {
    const path = cursor !== undefined ? replay.eventIndex.fileByEvent.get(cursor.eventId) : undefined
    const scene = cursor !== undefined ? replay.scenes[indexOfId(cursor.sceneId)] : undefined
    dispatch({ type: "selectFile", path: path ?? scene?.filePaths[0] })
  }, [replay, cursor])
  const markReviewed = useCallback(() => {
    if (state.view === "changes" && state.selectedFile !== undefined) toggle("files", state.selectedFile)
    else if (cursor !== undefined && state.started) toggle("scenes", reviewKey(replay.scenes[indexOfId(cursor.sceneId)]!))
  }, [state.view, state.selectedFile, state.started, cursor, toggle])
  const escape = useCallback(() => {
    if (state.selectedFile !== undefined) dispatch({ type: "selectFile", path: undefined })
    else if (state.view !== "story") dispatch({ type: "view", view: "story" })
    else dispatch({ type: "pause" })
  }, [state.selectedFile, state.view])
  useShortcuts({ dispatch, focusFile, markReviewed, escape })

  const changed = [...replay.files.values()].filter((f) => f.changeCount > 0)
  const reviewedFiles = changed.filter((f) => review.reviewedFiles.has(f.path)).length
  const chapter = cursor !== undefined ? replay.chapters[indexOfId(cursor.chapterId)] : undefined
  const scene = cursor !== undefined ? replay.scenes[indexOfId(cursor.sceneId)] : undefined

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="wordmark">Replay</a>
        <span className="topbar__title" title={replay.title}>{replay.title}</span>
        <nav className="views" role="tablist">
          {(["story", "changes", "events"] as const satisfies ReadonlyArray<View>).map((v) => (
            <button key={v} role="tab" aria-selected={state.view === v} className={state.view === v ? "is-on" : ""} onClick={() => dispatch({ type: "view", view: v })}>
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </nav>
        <button className="views__fleet" onClick={startTour} title="What each part of this page shows">Tour</button>
        <a className="views__fleet" href={formatRoute({ page: "fleet", session: replay.session.id })} title="This session, its subagents and their steps over time">
          Fleet
        </a>
        <span className="progress" title="Changed files marked reviewed">
          {changed.length > 0 ? `${reviewedFiles} / ${changed.length} files reviewed` : ""}
        </span>
      </header>

      <main className="main">
        {state.view === "story" && (
          <StoryView
            replay={replay}
            state={state}
            cursor={cursor}
            dispatch={dispatch}
            review={review}
            toggleReview={toggle}
            inspect={inspect}
            jev={jev}
          />
        )}
        {state.view === "changes" && (
          <ChangesView replay={replay} selected={state.selectedFile} dispatch={dispatch} review={review} toggleReview={toggle} />
        )}
        {state.view === "events" && (
          <EventsView replay={replay} cursorEvent={cursor?.eventId} inspected={state.inspected} dispatch={dispatch} />
        )}
      </main>

      {touring && <Tour steps={sessionTour} onClose={closeTour} />}
      <footer className="playback">
        <div className="playback__controls">
          <IconButton label="Previous chapter (K)" onClick={() => dispatch({ type: "chapter", by: -1 })}>⏮</IconButton>
          <IconButton label="Previous scene (Shift+←)" onClick={() => dispatch({ type: "scene", by: -1 })}>◀</IconButton>
          <button className="play" onClick={() => dispatch({ type: "toggle" })} aria-label={state.status === "playing" ? "Pause" : "Play"}>
            {state.status === "playing" ? "❚❚" : "▶"}
          </button>
          <IconButton label="Next scene (Shift+→)" onClick={() => dispatch({ type: "scene", by: 1 })}>▶</IconButton>
          <IconButton label="Next chapter (J)" onClick={() => dispatch({ type: "chapter", by: 1 })}>⏭</IconButton>
          <select
            value={state.speed}
            onChange={(e) => dispatch({ type: "speed", speed: Number(e.target.value) as Speed })}
            aria-label="Playback speed"
          >
            {speeds.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
        <Timeline replay={replay} index={state.index} onSeek={(index) => dispatch({ type: "seek", index })} />
        <div className="playback__where">
          {state.started && chapter !== undefined && scene !== undefined
            ? (
              <>
                <span className="clip">{chapter.index + 1}. {chapter.title} › {scene.title}</span>
                <span className="muted">
                  {state.index + 1}/{replay.timeline.entries.length}
                  {cursor?.sourceTimestamp !== undefined ? ` · ${formatTime(cursor.sourceTimestamp)}` : ""}
                  {state.status === "ended" ? " · end" : ""}
                </span>
              </>
            )
            : <span className="muted">Overview · {replay.chapters.length} chapters · {replay.scenes.length} scenes</span>}
        </div>
      </footer>
    </div>
  )
}

const IconButton = ({ label, onClick, children }: { label: string; onClick: () => void; children: string }) => (
  <button className="icon" onClick={onClick} aria-label={label} title={label}>{children}</button>
)

