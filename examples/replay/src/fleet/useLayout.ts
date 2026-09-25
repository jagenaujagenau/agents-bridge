import { useEffect, useState } from "react"
import type { FleetPosition } from "./layout.ts"
import type { Fleet } from "./model.ts"

/**
 * The fleet layout, computed in a worker and cached: it is deterministic, so a fleet with
 * the same nodes and links always gets the same positions and never needs computing twice.
 */

// Bump when the layout algorithm changes, so stale positions are not reused.
const VERSION = "v2"
const PREFIX = `replay:fleet-layout:${VERSION}:`
const KEEP = 6
const memory = new Map<string, ReadonlyMap<string, FleetPosition>>()

/** A short, stable signature of a fleet's shape: its nodes and links, in order. */
export const fleetSignature = (fleet: Fleet): string => {
  let h = 2166136261
  const add = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  }
  for (const n of fleet.nodes) add(`${n.id}|${n.kind}|${n.size}\n`)
  for (const l of fleet.links) add(`${l.source}>${l.target}\n`)
  return `${fleet.scope}:${fleet.nodes.length}:${(h >>> 0).toString(36)}`
}

const load = (key: string): ReadonlyMap<string, FleetPosition> | undefined => {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? undefined : new Map(JSON.parse(raw) as Array<[string, FleetPosition]>)
  } catch {
    return undefined
  }
}

const save = (key: string, positions: ReadonlyMap<string, FleetPosition>) => {
  try {
    // Rounded to a tenth: positions are screen geometry, not data.
    const compact = [...positions].map(([id, p]) => [id, { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, r: p.r }])
    localStorage.setItem(PREFIX + key, JSON.stringify(compact))
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("replay:fleet-layout:"))
    // Keep the few most recent layouts; drop older versions and the rest.
    for (const k of keys.filter((k) => !k.startsWith(PREFIX))) localStorage.removeItem(k)
    const mine = keys.filter((k) => k.startsWith(PREFIX) && k !== PREFIX + key)
    for (const k of mine.slice(0, Math.max(0, mine.length - (KEEP - 1)))) localStorage.removeItem(k)
  } catch {
    // Full or unavailable storage only costs a recomputation next time.
  }
}

let worker: Worker | undefined
const layoutWorker = () => (worker ??= new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" }))

export const useFleetLayout = (fleet: Fleet): ReadonlyMap<string, FleetPosition> | undefined => {
  const key = fleetSignature(fleet)
  const [state, setState] = useState<{ key: string; positions: ReadonlyMap<string, FleetPosition> } | undefined>(() => {
    const cached = memory.get(key) ?? load(key)
    return cached === undefined ? undefined : { key, positions: cached }
  })
  useEffect(() => {
    const cached = memory.get(key) ?? load(key)
    if (cached !== undefined) {
      memory.set(key, cached)
      setState({ key, positions: cached })
      return
    }
    let live = true
    const w = layoutWorker()
    const onMessage = (event: MessageEvent<Array<[string, FleetPosition]>>) => {
      const positions = new Map(event.data)
      memory.set(key, positions)
      save(key, positions)
      if (live) setState({ key, positions })
    }
    w.addEventListener("message", onMessage, { once: true })
    w.postMessage(fleet)
    return () => {
      live = false
      w.removeEventListener("message", onMessage)
    }
  }, [key, fleet])
  return state?.key === key ? state.positions : undefined
}
