import { useEffect } from "react"
import type { Action, Detail, Speed } from "./reducer.ts"

/** Keyboard controls (GOAL §29). Modified keys and typing in inputs are left to the browser. */

export interface ShortcutHandlers {
  readonly dispatch: (action: Action) => void
  readonly focusFile: () => void
  readonly markReviewed: () => void
  readonly escape: () => void
}

const speeds: Record<string, Speed> = { "1": 1, "2": 2, "4": 4, "8": 8 }
const details: Record<string, Detail> = { d: "diff", t: "terminal", e: "evidence" }

export const useShortcuts = ({ dispatch, focusFile, markReviewed, escape }: ShortcutHandlers) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      // Space and Enter belong to the focused control: a focused tab or button activates, playback does not toggle.
      const control = target?.closest?.("button, a[href], summary, [role=button], [role=tab], [role=option]")
      if ((key === " " || key === "Enter") && control !== null && control !== undefined) return
      let handled = true
      if (key === " ") dispatch({ type: "toggle" })
      else if (key === "ArrowRight") dispatch(event.shiftKey ? { type: "scene", by: 1 } : { type: "step", by: 1 })
      else if (key === "ArrowLeft") dispatch(event.shiftKey ? { type: "scene", by: -1 } : { type: "step", by: -1 })
      else if (key === "j") dispatch({ type: "chapter", by: 1 })
      else if (key === "k") dispatch({ type: "chapter", by: -1 })
      else if (speeds[key] !== undefined) dispatch({ type: "speed", speed: speeds[key] })
      else if (details[key] !== undefined) dispatch({ type: "detail", detail: details[key] })
      else if (key === "f") focusFile()
      else if (key === "r") markReviewed()
      else if (key === "Escape") escape()
      else handled = false
      if (handled) event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [dispatch, focusFile, markReviewed, escape])
}
