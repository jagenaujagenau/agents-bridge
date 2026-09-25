import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

/**
 * A short guided tour: each step spotlights one part of the screen and explains what it
 * shows. Steps whose target is not on screen are skipped, so the tour adapts to the layout.
 */

export interface TourStep {
  /** A CSS selector; without one the card is centered, for an introduction or a wrap-up. */
  readonly target?: string | undefined
  readonly title: string
  readonly body: React.ReactNode
}

export interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

const GAP = 12
const MARGIN = 12

/**
 * Where the card goes: beside the target on whichever side has room (below, right, above,
 * left, in that order), kept inside the viewport; centered when nothing fits or there is no
 * target.
 */
export const placeCard = (
  target: Rect | undefined,
  card: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): { readonly top: number; readonly left: number; readonly side: "below" | "right" | "above" | "left" | "center" } => {
  const clampLeft = (left: number) => Math.min(Math.max(MARGIN, left), viewport.width - card.width - MARGIN)
  const clampTop = (top: number) => Math.min(Math.max(MARGIN, top), viewport.height - card.height - MARGIN)
  const center = {
    top: Math.max(MARGIN, (viewport.height - card.height) / 2),
    left: Math.max(MARGIN, (viewport.width - card.width) / 2),
    side: "center" as const
  }
  if (target === undefined) return center
  const below = target.top + target.height + GAP
  if (below + card.height <= viewport.height - MARGIN) {
    return { top: below, left: clampLeft(target.left + target.width / 2 - card.width / 2), side: "below" }
  }
  const right = target.left + target.width + GAP
  if (right + card.width <= viewport.width - MARGIN) {
    return { top: clampTop(target.top + target.height / 2 - card.height / 2), left: right, side: "right" }
  }
  const above = target.top - GAP - card.height
  if (above >= MARGIN) return { top: above, left: clampLeft(target.left + target.width / 2 - card.width / 2), side: "above" }
  const left = target.left - GAP - card.width
  if (left >= MARGIN) return { top: clampTop(target.top + target.height / 2 - card.height / 2), left, side: "left" }
  return center
}

/** Whether the tour has been seen, remembered per browser. A convenience: losing it only repeats the tour. */
export const tourSeen = {
  get: (key: string): boolean => {
    try {
      return localStorage.getItem(key) === "1"
    } catch {
      return true
    }
  },
  set: (key: string) => {
    try {
      localStorage.setItem(key, "1")
    } catch {
      // Unavailable storage: the tour may show again next time.
    }
  }
}

const visibleRect = (selector: string | undefined): Rect | undefined => {
  if (selector === undefined) return undefined
  const el = document.querySelector(selector)
  if (el === null) return undefined
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : undefined
}

export const Tour = ({ steps, onClose }: { readonly steps: ReadonlyArray<TourStep>; readonly onClose: () => void }) => {
  // Only steps that can be shown: a target hidden by the layout is skipped. Measured after the
  // first paint, since the page under the tour may be rendering in the same pass.
  const [shown, setShown] = useState<ReadonlyArray<TourStep> | undefined>()
  useLayoutEffect(() => {
    setShown(steps.filter((s) => s.target === undefined || visibleRect(s.target) !== undefined))
  }, [steps])
  return shown === undefined || shown.length === 0 ? null : <TourSteps shown={shown} onClose={onClose} />
}

const TourSteps = ({ shown, onClose }: { readonly shown: ReadonlyArray<TourStep>; readonly onClose: () => void }) => {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | undefined>()
  const [cardSize, setCardSize] = useState({ width: 340, height: 180 })
  const card = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const step = shown[index]!
  const last = index === shown.length - 1

  // Bring the target into view, then measure it; follow resizes and scrolling.
  useLayoutEffect(() => {
    const el = step.target !== undefined ? document.querySelector(step.target) : null
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
    const measure = () => setRect(visibleRect(step.target))
    measure()
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [step])

  useLayoutEffect(() => {
    const el = card.current
    if (el !== null) setCardSize({ width: el.offsetWidth, height: el.offsetHeight })
    next.current?.focus()
  }, [index])

  const go = useCallback((by: 1 | -1) => {
    if (by === 1 && last) onClose()
    else setIndex((i) => Math.min(shown.length - 1, Math.max(0, i + by)))
  }, [last, onClose, shown.length])

  // The tour owns the keyboard while open, ahead of the page's playback shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      else if (event.key === "ArrowRight" || event.key === "Enter") go(1)
      else if (event.key === "ArrowLeft") go(-1)
      else if (event.key !== "Tab") return
      if (event.key !== "Tab") event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [go, onClose])

  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const place = placeCard(rect, cardSize, viewport)
  const pad = 6
  return (
    <div className="tour" aria-live="polite">
      {rect !== undefined
        ? (
          <div
            className="tour__spot"
            style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
          />
        )
        : <div className="tour__scrim" />}
      <div
        ref={card}
        className={`tour__card is-${place.side}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        style={{ top: place.top, left: place.left }}
      >
        <p className="eyebrow">Tour · {index + 1} of {shown.length}</p>
        <h3 id="tour-title">{step.title}</h3>
        <div className="tour__body">{step.body}</div>
        <div className="tour__actions">
          <button className="link" onClick={onClose}>{last ? "Close" : "Skip tour"}</button>
          <span>
            {index > 0 && <button className="ghost" onClick={() => go(-1)}>Back</button>}
            <button ref={next} className="primary tour__next" onClick={() => go(1)}>{last ? "Start exploring" : "Next"}</button>
          </span>
        </div>
      </div>
    </div>
  )
}
