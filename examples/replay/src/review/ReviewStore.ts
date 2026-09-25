import { useCallback, useState } from "react"
import type { EventId } from "@agentbridge/schema"

/**
 * Review state (GOAL §27). Replay's own data, kept in localStorage per session;
 * never written into Bridge's canonical model.
 */

/**
 * Chapters and scenes are keyed by the event that opens them, not by position: `sc3` can
 * name different content after the derivation changes or the session grows, but an event
 * ID always names the same evidence.
 */
export interface ReviewState {
  readonly reviewedChapters: ReadonlySet<string>
  readonly reviewedScenes: ReadonlySet<string>
  readonly reviewedFiles: ReadonlySet<string>
}

export const reviewKey = (unit: { readonly eventIds: ReadonlyArray<EventId> }): string => unit.eventIds[0] ?? ""

type Kind = "chapters" | "scenes" | "files"
type Stored = Partial<Record<Kind, ReadonlyArray<string>>>

// v2: keys are opening event IDs; v1 used positional chapter and scene IDs and is not read.
const key = (sessionId: string) => `replay:review:v2:${sessionId}`

const load = (sessionId: string): ReviewState => {
  let stored: unknown
  try {
    stored = JSON.parse(localStorage.getItem(key(sessionId)) ?? "{}")
  } catch {
    // Unavailable or corrupt storage: start unreviewed.
  }
  // Anything but arrays of strings is ignored rather than trusted.
  const list = (field: Kind): Array<string> => {
    const value = typeof stored === "object" && stored !== null ? (stored as Stored)[field] : undefined
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
  }
  return {
    reviewedChapters: new Set(list("chapters")),
    reviewedScenes: new Set(list("scenes")),
    reviewedFiles: new Set(list("files"))
  }
}

const save = (sessionId: string, state: ReviewState) => {
  try {
    localStorage.setItem(key(sessionId), JSON.stringify({
      chapters: [...state.reviewedChapters],
      scenes: [...state.reviewedScenes],
      files: [...state.reviewedFiles]
    }))
  } catch {
    // Review state is a convenience; losing it is acceptable.
  }
}

const field = { chapters: "reviewedChapters", scenes: "reviewedScenes", files: "reviewedFiles" } as const

export const useReview = (sessionId: string) => {
  const [state, setState] = useState(() => load(sessionId))
  const toggle = useCallback((kind: Kind, id: string) => {
    setState((current) => {
      const set = new Set<string>(current[field[kind]])
      if (set.has(id)) set.delete(id)
      else set.add(id)
      const next = { ...current, [field[kind]]: set } as ReviewState
      save(sessionId, next)
      return next
    })
  }, [sessionId])
  return { review: state, toggle }
}
