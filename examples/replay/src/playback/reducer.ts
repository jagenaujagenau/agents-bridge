import type { EventId, SessionEvent } from "@agentbridge/schema"
import type { View } from "../app/routes.ts"
import { type ChapterId, indexOfId, type ReplaySession, type SceneId } from "../replay/model.ts"

/**
 * One canonical playback cursor (GOAL §13–15). The only position state is `index`,
 * a timeline index; chapter, scene, highlighted files, diff and terminal all derive
 * from it.
 */

export type Speed = 0.5 | 1 | 2 | 4 | 8
export type Detail = "evidence" | "diff" | "terminal" | "tool"

export interface PlaybackState {
  readonly status: "paused" | "playing" | "ended"
  readonly index: number
  readonly speed: Speed
  /** Left the overview for the walkthrough. */
  readonly started: boolean
  readonly view: View
  readonly detail: Detail
  /** Selection is separate from the cursor: selecting a file never moves playback. */
  readonly selectedFile?: string | undefined
  /** Inspected event in the Events view; may be one playback skips. */
  readonly inspected?: EventId | undefined
}

export interface ReplayCursor {
  readonly chapterId: ChapterId
  readonly sceneId: SceneId
  readonly eventIndex: number
  readonly eventId: EventId
  readonly sourceTimestamp?: string | undefined
}

export type Action =
  | { readonly type: "play" | "pause" | "toggle" | "tick" }
  | { readonly type: "step"; readonly by: 1 | -1 }
  | { readonly type: "scene"; readonly by: 1 | -1 }
  | { readonly type: "chapter"; readonly by: 1 | -1 }
  | { readonly type: "seek"; readonly index: number }
  | { readonly type: "seekEvent"; readonly eventId: EventId; readonly inspect?: boolean }
  /** Explicit navigation to an event from anywhere: seek, select its file, open the fitting inspector in Story. */
  | { readonly type: "openEvent"; readonly eventId: EventId }
  | { readonly type: "seekScene"; readonly sceneId: SceneId }
  | { readonly type: "seekChapter"; readonly chapterId: ChapterId }
  | { readonly type: "speed"; readonly speed: Speed }
  | { readonly type: "selectFile"; readonly path: string | undefined }
  | { readonly type: "view"; readonly view: View }
  | { readonly type: "detail"; readonly detail: Detail }
  | { readonly type: "overview" }

export const initialState = (view: View = "story"): PlaybackState => ({
  status: "paused",
  index: 0,
  speed: 1,
  started: false,
  view,
  detail: "evidence"
})

export const cursorOf = (replay: ReplaySession, index: number): ReplayCursor | undefined => {
  const entry = replay.timeline.entries[index]
  return entry === undefined ? undefined : {
    chapterId: entry.chapterId,
    sceneId: entry.sceneId,
    eventIndex: index,
    eventId: entry.eventId,
    sourceTimestamp: entry.timestamp
  }
}

/** The timeline index at or after an event, for events playback does not stop on. */
export const indexForEvent = (replay: ReplaySession, eventId: EventId): number | undefined => {
  const direct = replay.timeline.indexByEvent.get(eventId)
  if (direct !== undefined) return direct
  const event = replay.eventIndex.eventById.get(eventId)
  const scene = replay.eventIndex.sceneByEvent.get(eventId)
  if (event === undefined) return undefined
  const entries = replay.timeline.entries
  const after = entries.findIndex((e) => e.sequence >= event.sequence && (scene === undefined || e.sceneId === scene))
  if (after >= 0) return after
  return scene !== undefined ? replay.timeline.firstIndexByScene.get(scene) : undefined
}

/** The inspector that shows an event best. */
export const detailFor = (event: SessionEvent | undefined): Detail => {
  switch (event?.type) {
    case "file.created":
    case "file.changed":
    case "file.deleted":
      return "diff"
    case "command.started":
    case "command.completed":
      return "terminal"
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
    case "tool.failed":
      return "tool"
    default:
      return "evidence"
  }
}

export const makeReducer = (replay: ReplaySession) => {
  const last = Math.max(0, replay.timeline.entries.length - 1)
  const clamp = (i: number) => Math.min(last, Math.max(0, i))
  const at = (state: PlaybackState, index: number): PlaybackState => ({
    ...state,
    index: clamp(index),
    started: true,
    status: state.status === "ended" ? "paused" : state.status
  })
  const sceneStart = (id: SceneId | undefined) => (id === undefined ? undefined : replay.timeline.firstIndexByScene.get(id))
  const chapterStart = (id: ChapterId | undefined) => (id === undefined ? undefined : replay.timeline.firstIndexByChapter.get(id))

  return (state: PlaybackState, action: Action): PlaybackState => {
    const cursor = cursorOf(replay, state.index)
    switch (action.type) {
      case "play":
        return { ...state, started: true, status: "playing", index: state.status === "ended" ? 0 : state.index }
      case "pause":
        return { ...state, status: state.status === "playing" ? "paused" : state.status }
      case "toggle":
        return state.status === "playing"
          ? { ...state, status: "paused" }
          : { ...state, started: true, status: "playing", index: state.status === "ended" ? 0 : state.index }
      case "tick":
        if (state.status !== "playing") return state
        return state.index >= last ? { ...state, status: "ended" } : { ...state, index: state.index + 1 }
      case "step":
        return at(state, state.index + action.by)
      case "scene": {
        if (cursor === undefined) return state
        const i = indexOfId(cursor.sceneId)
        // Back from the middle of a scene returns to its start first.
        const own = sceneStart(cursor.sceneId) ?? 0
        if (action.by === -1 && state.index > own) return at(state, own)
        const target = replay.scenes[i + action.by]
        return target === undefined ? state : at(state, sceneStart(target.id) ?? state.index)
      }
      case "chapter": {
        if (cursor === undefined) return state
        const i = indexOfId(cursor.chapterId)
        const own = chapterStart(cursor.chapterId) ?? 0
        if (action.by === -1 && state.index > own) return at(state, own)
        const target = replay.chapters[i + action.by]
        return target === undefined ? state : at(state, chapterStart(target.id) ?? state.index)
      }
      case "seek":
        return at(state, action.index)
      case "seekEvent": {
        const index = indexForEvent(replay, action.eventId)
        const next = index === undefined ? state : at(state, index)
        return action.inspect === true ? { ...next, inspected: action.eventId } : next
      }
      case "openEvent": {
        const index = indexForEvent(replay, action.eventId)
        if (index === undefined) return state
        return {
          ...at(state, index),
          view: "story",
          inspected: action.eventId,
          selectedFile: replay.eventIndex.fileByEvent.get(action.eventId),
          detail: detailFor(replay.eventIndex.eventById.get(action.eventId))
        }
      }
      case "seekScene":
        return at(state, sceneStart(action.sceneId) ?? state.index)
      case "seekChapter":
        return at(state, chapterStart(action.chapterId) ?? state.index)
      case "speed":
        return { ...state, speed: action.speed }
      case "selectFile":
        return { ...state, selectedFile: action.path }
      case "view":
        return { ...state, view: action.view }
      case "detail":
        return { ...state, detail: action.detail }
      case "overview":
        return { ...state, started: false, status: "paused", index: 0 }
    }
  }
}
