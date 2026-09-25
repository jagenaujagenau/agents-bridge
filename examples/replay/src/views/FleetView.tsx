import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchFamily, fetchListing, fetchTitles, type Listing } from "../app/api.ts"
import { formatRoute, sessionHref } from "../app/routes.ts"
import { formatDuration } from "../components/format.ts"
import { useFleetLayout } from "../fleet/useLayout.ts"
import {
  activeAt,
  buildFleet,
  buildSessionFleet,
  familyOf,
  type FamilyMember,
  type Fleet,
  type FleetNode,
  histogram,
  projectName,
  type TimeAxis,
  timeAxis,
  projectOf,
  rootOf,
  spawnedBy
} from "../fleet/model.ts"

/**
 * Fleet: sessions over time. Sessions appear when they start and glow while they work;
 * spawn links hold each tree of subagents together. Two scopes share one screen:
 *
 *   #/fleet               every listed session, gathered around its project
 *   #/fleet?session=…     one session's family: its agents, each with its scenes as steps
 */

/** The validated categorical order for the dark surface (dataviz reference palette). */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]
const OTHER = "#6b6a66"
/** Agents in a session's own fleet: neutral hubs, named by their labels. */
const AGENT = "#ebe7df"
/** Reserved status color (dataviz): a failed check is marked with it, always with a label. */
const CRITICAL = "#d03b3b"
const DAY = 86_400_000
const SPEEDS = [1, 4, 10, 20] as const
/** At ×1 the whole span plays in this long, whether it is an hour or half a year. */
const PLAY_SECONDS = 120

const dateLabel = (t: number) => new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })
const timeLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const shortDate = (t: number) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })

export const FleetView = (
  { project, session }: { readonly project?: string | undefined; readonly session?: string | undefined }
) => {
  const [listing, setListing] = useState<Listing | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    fetchListing().then(setListing, (e: unknown) => setError(String((e as Error).message ?? e)))
  }, [])
  if (error !== undefined) return <main className="loading"><p className="error">Could not list sessions: {error}</p></main>
  if (listing === undefined) return <main className="loading"><p className="muted">Gathering sessions…</p></main>
  return session !== undefined ? <SessionFleet listing={listing} session={session} /> : <AllFleet listing={listing} project={project} />
}

/** Colors by type in a fixed order (most sessions first), so filtering never repaints a type. */
const colorsFor = (fleet: Fleet) => {
  const m = new Map(fleet.types.map((t, i) => [t.type, SERIES[i] ?? OTHER]))
  return (type: string) => m.get(type) ?? OTHER
}

const AllFleet = ({ listing, project }: { readonly listing: Listing; readonly project?: string | undefined }) => {
  const names = useMemo(() => new Map(listing.harnesses.map((h) => [h.id, h.name])), [listing])
  const everything = useMemo(() => buildFleet(listing.sessions, names), [listing, names])
  const colorOf = useMemo(() => colorsFor(everything), [everything])
  const fleet = useMemo(() => (project === undefined ? everything : buildFleet(listing.sessions, names, project)), [
    listing,
    names,
    project,
    everything
  ])
  const projectCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of listing.sessions) m.set(projectOf(d), (m.get(projectOf(d)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [listing])
  const sessions = fleet.nodes.length - fleet.projects.length
  const days = Math.max(1, Math.ceil((fleet.end - fleet.start) / DAY))
  return (
    <FleetScreen
      fleet={fleet}
      colorOf={colorOf}
      heading={project === undefined ? "All sessions" : projectName(project)}
      lede={`${sessions} sessions${project === undefined ? ` across ${fleet.projects.length} projects` : ""}, run by ${fleet.harnesses} harness${
        fleet.harnesses === 1 ? "" : "es"
      } over ${days} days, spawning ${fleet.subagents} subagent${fleet.subagents === 1 ? "" : "s"}.`}
      control={
        <select
          className="filepick fleet__project"
          value={project ?? ""}
          aria-label="Project"
          onChange={(e) => {
            window.location.hash = formatRoute({ page: "fleet", project: e.target.value === "" ? undefined : e.target.value })
          }}
        >
          <option value="">All projects</option>
          {projectCounts.map(([p, n]) => <option key={p} value={p}>{projectName(p)} ({n})</option>)}
        </select>
      }
    />
  )
}

/** One session's family, each agent read and derived so its scenes can orbit it. */
const SessionFleet = ({ listing, session }: { readonly listing: Listing; readonly session: string }) => {
  const names = useMemo(() => new Map(listing.harnesses.map((h) => [h.id, h.name])), [listing])
  const root = useMemo(() => rootOf(listing.sessions, session), [listing, session])
  const family = useMemo(() => familyOf(listing.sessions, root), [listing, root])
  const [members, setMembers] = useState<ReadonlyMap<string, FamilyMember> | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    fetchFamily(family.map((d) => d.id)).then(
      (all) => live && setMembers(all),
      (e: unknown) => live && setError(String((e as Error).message ?? e))
    )
    return () => {
      live = false
    }
  }, [family])
  const fleet = useMemo(() => (members === undefined ? undefined : buildSessionFleet(family, members, names)), [family, members, names])
  const colorOf = useMemo(() => (fleet === undefined ? undefined : colorsFor(fleet)), [fleet])

  if (family.length === 0) return <main className="loading"><p className="error">Session {session} is not in the listing.</p></main>
  if (error !== undefined) return <main className="loading"><p className="error">Could not read the session: {error}</p></main>
  if (fleet === undefined || colorOf === undefined) {
    return <main className="loading"><p className="muted">Reading {family.length} session{family.length === 1 ? "" : "s"}…</p></main>
  }
  const top = fleet.nodes.find((n) => n.id === root)!
  const steps = fleet.nodes.filter((n) => n.kind === "step").length
  return (
    <FleetScreen
      fleet={fleet}
      colorOf={colorOf}
      heading={top.label ?? projectName(top.project)}
      lede={`${fleet.subagents === 0 ? "One agent" : `${fleet.subagents + 1} agents`} in ${projectName(top.project)} took ${steps} step${
        steps === 1 ? "" : "s"
      } over ${formatDuration(fleet.end - fleet.start)}.`}
      control={
        <p className="fleet__links">
          <a href={sessionHref(root)}>Open the replay →</a> · <a href={formatRoute({ page: "fleet", project: top.project })}>This project's fleet</a>
        </p>
      }
    />
  )
}

interface ScreenProps {
  readonly fleet: Fleet
  readonly colorOf: (type: string) => string
  readonly heading: string
  readonly lede: string
  readonly control: React.ReactNode
}

const FleetScreen = ({ fleet, colorOf, heading, lede, control }: ScreenProps) => {
  const family = fleet.scope === "session"
  const span = Math.max(1, fleet.end - fleet.start)
  /**
   * Work is often brief next to the span played, so light would flash by unseen: a node
   * glows fully while working, then fades. "Working now" still counts strict spans only.
   */
  const afterglow = Math.min(DAY / 2, span / 30)
  const positions = useFleetLayout(fleet)
  // Playback and the strip move along a time axis with the dead time trimmed.
  const axis = useMemo(() => timeAxis(fleet), [fleet])

  const [t, setT] = useState(fleet.end)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4)
  const [isolated, setIsolated] = useState<string | undefined>()
  const [selected, setSelected] = useState<string | undefined>()
  useEffect(() => {
    setT(fleet.end)
    setSelected(undefined)
  }, [fleet])

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let frame = 0
    const step = (now: number) => {
      const dt = now - last
      last = now
      setT((current) => {
        const next = axis.time(axis.at(current) + ((dt / 1000) * speed) / PLAY_SECONDS)
        if (next >= fleet.end) {
          setPlaying(false)
          return fleet.end
        }
        return next
      })
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed, fleet, axis])

  const togglePlay = useCallback(() => {
    if (!playing && t >= fleet.end) setT(fleet.start)
    setPlaying(!playing)
  }, [playing, t, fleet])

  // Arrow keys move a hundredth of the strip: a step of activity, not of idle time.
  const nudge = (by: number) => (c: number) => axis.time(axis.at(c) + by)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (target?.closest?.("input, textarea, select, button, a[href]") && (event.key === " " || event.key === "Enter")) return
      if (event.key === " ") togglePlay()
      else if (event.key === "ArrowRight") setT(nudge(0.01))
      else if (event.key === "ArrowLeft") setT(nudge(-0.01))
      else if (event.key === "Escape") setSelected(undefined)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [togglePlay, fleet, axis])

  const active = activeAt(fleet, t)
  // Start times, sorted once: how many have started is a binary search, and the log is only
  // rebuilt when that count changes, not on every frame.
  const starts = useMemo(() => fleet.nodes.filter((n) => n.kind !== "project").map((n) => n.start).sort((a, b) => a - b), [fleet])
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid]! <= t) lo = mid + 1
    else hi = mid
  }
  const started = lo
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const spawned = useMemo(() => spawnedBy(fleet, t), [fleet, started])
  const sessions = fleet.nodes.filter((n) => n.kind === "session")
  const steps = fleet.nodes.filter((n) => n.kind === "step")
  const days = Math.max(1, Math.ceil(span / DAY))
  const day = Math.min(days, Math.floor((t - fleet.start) / DAY) + 1)
  const nodeById = useMemo(() => new Map(fleet.nodes.map((n) => [n.id, n])), [fleet])
  const selectedNode = selected !== undefined ? nodeById.get(selected) : undefined
  const failed = steps.filter((n) => n.failed === true && n.start <= t).length

  return (
    <div className="fleet">
      <aside className="fleet__left">
        <p className="eyebrow"><a href="#/">Replay</a> · {family ? <a href="#/fleet">Fleet</a> : "Fleet"}</p>
        <h1 className={family ? "is-long" : ""}>{heading}</h1>
        <p className="lede">{lede}</p>
        {control}
        <div className="fleet__card">
          <div className="fleet__date">{family ? timeLabel(t) : dateLabel(t)}</div>
          <div className="fleet__time mono">
            <span>{family ? dateLabel(t) : timeLabel(t)}</span>
            <span>{family ? `${formatDuration(Math.max(0, t - fleet.start))} of ${formatDuration(span)}` : `day ${day} of ${days}`}</span>
          </div>
        </div>
        <div className="fleet__card fleet__stats">
          {family
            ? (
              <>
                <div>
                  <dt>Steps taken</dt>
                  <dd>{spawned.filter((n) => n.kind === "step").length}<small> / {steps.length}</small></dd>
                </div>
                <div>
                  <dt>Agents working</dt>
                  <dd>{active.length}</dd>
                </div>
                <div>
                  <dt>Subagents</dt>
                  <dd>{spawned.filter((n) => n.kind === "session" && n.parentId !== undefined).length}</dd>
                </div>
                <div>
                  <dt>Failed checks</dt>
                  <dd className={failed > 0 ? "is-failed" : ""}>{failed}</dd>
                </div>
              </>
            )
            : (
              <>
                <div>
                  <dt>Sessions started</dt>
                  <dd>{spawned.length}<small> / {sessions.length}</small></dd>
                </div>
                <div>
                  <dt>Working now</dt>
                  <dd>{active.length}</dd>
                </div>
                <div>
                  <dt>Subagents</dt>
                  <dd>{spawned.filter((n) => n.parentId !== undefined).length}</dd>
                </div>
                <div>
                  <dt>Projects</dt>
                  <dd>{new Set(spawned.map((n) => n.project)).size}</dd>
                </div>
              </>
            )}
        </div>
        <div className="fleet__card">
          <div className="fleet__legend-head">
            <span className="eyebrow">{family ? "Steps" : "Types"}</span>
            <span className="muted">click to isolate</span>
          </div>
          <ul className="fleet__legend">
            {fleet.types.map(({ type, count }) => (
              <li key={type}>
                <button
                  className={`plain ${isolated !== undefined && isolated !== type ? "is-dim" : ""}`}
                  aria-pressed={isolated === type}
                  onClick={() => setIsolated(isolated === type ? undefined : type)}
                >
                  <i style={{ background: colorOf(type) }} />
                  <span className="clip">{type}</span>
                  <span className="mono">{count}</span>
                  <span className="fleet__bar">
                    <span style={{ width: `${(count / fleet.types[0]!.count) * 100}%`, background: colorOf(type) }} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {family && (
            <p className="fleet__ring-note"><i style={{ background: AGENT, borderColor: AGENT }} /> agents: {sessions.length}, named on the map</p>
          )}
          {family && steps.some((n) => n.failed === true) && (
            <p className="fleet__ring-note"><i style={{ borderColor: CRITICAL }} /> ringed: a check that failed</p>
          )}
        </div>
      </aside>

      {positions === undefined ? <div className="fleet__canvas fleet__pending"><p className="muted">Laying out {fleet.nodes.length} nodes…</p></div> : <FleetCanvas
        fleet={fleet}
        positions={positions}
        t={t}
        afterglow={afterglow}
        colorOf={colorOf}
        isolated={isolated}
        selected={selected}
        onSelect={setSelected}
      />}

      <aside className="fleet__right">
        {selectedNode !== undefined && selectedNode.kind !== "project" && (
          <SelectedCard node={selectedNode} fleet={fleet} colorOf={colorOf} nodeById={nodeById} onSelect={setSelected} />
        )}
        <SpawnLog spawned={spawned} family={family} colorOf={colorOf} nodeById={nodeById} onSelect={setSelected} />
        <div className="fleet__card fleet__howto">
          <span className="eyebrow">How to read it</span>
          {family
            ? (
              <>
                <p><b>Agents are hubs.</b> Each agent's scenes orbit it; subagents link to the agent that spawned them.</p>
                <p><b>Light is work.</b> A step appears when it starts and glows while it runs, then fades.</p>
                <p><b>Size is effort.</b> Larger steps hold more recorded events.</p>
              </>
            )
            : (
              <>
                <p><b>Distance is relationship.</b> Spawn links hold each tree of subagents together; top-level sessions gather around their project.</p>
                <p><b>Light is work.</b> Sessions appear when they start, glow between their first and last recorded activity, then fade.</p>
                <p><b>Size is volume.</b> Larger dots hold more recorded history.</p>
              </>
            )}
        </div>
      </aside>

      <footer className="fleet__bar-bottom">
        <button className="play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
        <div className="segmented" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? "is-on" : ""} onClick={() => setSpeed(s)} title={`plays the whole span in ${Math.round(PLAY_SECONDS / s)}s`}>
              ×{s}
            </button>
          ))}
        </div>
        <ActivityStrip fleet={fleet} axis={axis} t={t} colorOf={colorOf} onSeek={(time) => setT(time)} />
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

interface CanvasProps {
  readonly fleet: Fleet
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly r: number }>
  readonly t: number
  readonly afterglow: number
  readonly colorOf: (type: string) => string
  readonly isolated: string | undefined
  readonly selected: string | undefined
  readonly onSelect: (id: string | undefined) => void
}

/**
 * A soft glow, rendered once per color and stamped with drawImage: creating a radial
 * gradient per glowing node per frame was the canvas's main cost during playback.
 */
const glowSprites = new Map<string, HTMLCanvasElement>()
const glowSprite = (color: string): HTMLCanvasElement => {
  let sprite = glowSprites.get(color)
  if (sprite === undefined) {
    sprite = document.createElement("canvas")
    sprite.width = sprite.height = 64
    const g = sprite.getContext("2d")!
    const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, "transparent")
    g.fillStyle = gradient
    g.fillRect(0, 0, 64, 64)
    glowSprites.set(color, sprite)
  }
  return sprite
}

/** The selected session's whole tree: its ancestors and everything it spawned. */
const treeOf = (fleet: Fleet, id: string): ReadonlySet<string> => {
  const parent = new Map(fleet.nodes.map((n) => [n.id, n.parentId]))
  const children = new Map<string, Array<string>>()
  for (const n of fleet.nodes) if (n.parentId !== undefined) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id])
  let root = id
  while (parent.get(root) !== undefined) root = parent.get(root)!
  const out = new Set<string>()
  const walk = (at: string) => {
    out.add(at)
    for (const c of children.get(at) ?? []) walk(c)
  }
  walk(root)
  return out
}

const FleetCanvas = ({ fleet, positions, t, afterglow, colorOf, isolated, selected, onSelect }: CanvasProps) => {
  const ref = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | undefined>()
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined)
  const tree = useMemo(() => (selected !== undefined ? treeOf(fleet, selected) : undefined), [fleet, selected])
  const lookup = useMemo(() => ({ byId: new Map(fleet.nodes.map((n) => [n.id, n])) }), [fleet])
  const reduced = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, [])

  // A session picked from the log may be off-screen: bring it to the middle.
  useEffect(() => {
    const p = selected !== undefined ? positions.get(selected) : undefined
    if (p === undefined) return
    setView((v) => {
      const sx = p.x * v.k + v.x
      const sy = p.y * v.k + v.y
      const inside = sx > 40 && sx < size.w - 40 && sy > 40 && sy < size.h - 40
      return inside ? v : { ...v, x: size.w / 2 - p.x * v.k, y: size.h / 2 - p.y * v.k }
    })
  }, [selected, positions, size])

  // Fit the whole fleet on load and whenever the fleet changes.
  useEffect(() => {
    const xs = [...positions.values()].map((p) => p.x)
    const ys = [...positions.values()].map((p) => p.y)
    if (xs.length === 0) return
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    // A small fleet is not blown up to fill the screen.
    const k = Math.min(size.w / (maxX - minX + 60), size.h / (maxY - minY + 60), 3)
    setView({ k, x: size.w / 2 - ((minX + maxX) / 2) * k, y: size.h / 2 - ((minY + maxY) / 2) * k })
  }, [positions, size])

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (canvas === null) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    ctx.translate(view.x, view.y)
    ctx.scale(view.k, view.k)

    const byId = lookup.byId
    const visible = (n: FleetNode) => n.start <= t
    const faded = (n: FleetNode) =>
      (isolated !== undefined && n.kind !== "project" && !(fleet.scope === "session" && n.kind === "session") && n.type !== isolated) ||
      (tree !== undefined && !tree.has(n.id))

    // Links first, recessive.
    ctx.lineWidth = 0.6 / Math.sqrt(view.k)
    for (const link of fleet.links) {
      const a = byId.get(link.source)!
      const b = byId.get(link.target)!
      if (!visible(a) || !visible(b)) continue
      const pa = positions.get(a.id)!
      const pb = positions.get(b.id)!
      ctx.strokeStyle = link.kind === "project" || (fleet.scope === "session" && link.kind === "spawn") ? "#ffffff" : colorOf(a.type)
      ctx.globalAlpha = (link.kind === "spawn" ? 0.45 : link.kind === "step" ? 0.25 : 0.08) * (faded(a) ? 0.15 : 1)
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
      ctx.stroke()
    }

    for (const n of fleet.nodes) {
      if (!visible(n)) continue
      const p = positions.get(n.id)!
      const dim = faded(n)
      if (n.kind === "project") {
        ctx.globalAlpha = dim ? 0.2 : 0.9
        ctx.fillStyle = "#ebe7df"
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      const working = n.start <= t && t <= n.end
      const light = working ? 1 : Math.max(0, 1 - (t - n.end) / afterglow)
      const color = fleet.scope === "session" && n.kind === "session" ? AGENT : colorOf(n.type)
      if (light > 0 && !dim && !reduced) {
        ctx.globalAlpha = 0.55 * light
        ctx.drawImage(glowSprite(color), p.x - p.r * 4, p.y - p.r * 4, p.r * 8, p.r * 8)
      }
      ctx.globalAlpha = dim ? 0.12 : 0.6 + 0.4 * light
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
      if (n.failed === true) {
        // A failed check: the reserved critical color, named in the legend.
        ctx.globalAlpha = dim ? 0.25 : 1
        ctx.strokeStyle = "#d03b3b"
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r + 1.4, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (n.id === selected || working) {
        ctx.globalAlpha = dim ? 0.2 : 1
        ctx.strokeStyle = n.id === selected ? "#ffffff" : "#0f1012"
        ctx.lineWidth = n.id === selected ? 1.4 : 0.5
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // Project names, and the names of sessions working right now (few at a time).
    ctx.globalAlpha = 1
    ctx.font = `500 ${11 / view.k}px Inter, system-ui, sans-serif`
    ctx.textAlign = "center"
    const members = new Map<string, number>()
    for (const n of fleet.nodes) if (n.kind === "session" && n.start <= t) members.set(n.project, (members.get(n.project) ?? 0) + 1)
    // In a session's own fleet, name each agent beside its hub.
    if (fleet.scope === "session") {
      ctx.textAlign = "left"
      for (const n of fleet.nodes) {
        if (n.kind !== "session" || !visible(n)) continue
        const p = positions.get(n.id)!
        ctx.fillStyle = faded(n) ? "rgba(152,148,139,0.3)" : "#cfcac0"
        const name = n.label ?? n.type
        ctx.fillText(name.length > 42 ? `${name.slice(0, 41)}…` : name, p.x + p.r + 5 / view.k, p.y + 4 / view.k)
      }
      ctx.textAlign = "center"
    }
    for (const n of fleet.nodes) {
      if (n.kind !== "project" || !visible(n)) continue
      if ((members.get(n.project) ?? 0) < 6 && fleet.projects.length > 1) continue
      const p = positions.get(n.id)!
      ctx.fillStyle = faded(n) ? "rgba(152,148,139,0.3)" : "#98948b"
      ctx.fillText(projectName(n.project), p.x, p.y - 8 / view.k)
    }
  }, [fleet, lookup, positions, t, colorOf, isolated, tree, selected, size, view, reduced])

  const toWorld = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect()
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k }
  }
  const hit = (clientX: number, clientY: number): string | undefined => {
    const w = toWorld(clientX, clientY)
    let best: string | undefined
    let bestD = 8 / view.k
    for (const n of fleet.nodes) {
      if (n.kind === "project" || n.start > t) continue
      const p = positions.get(n.id)!
      const d = Math.hypot(p.x - w.x, p.y - w.y) - p.r
      if (d < bestD) {
        bestD = d
        best = n.id
      }
    }
    return best
  }

  const hoverNode = hover !== undefined ? fleet.nodes.find((n) => n.id === hover.id) : undefined
  return (
    <div className="fleet__canvas">
      <canvas
        ref={ref}
        role="img"
        aria-label={`Fleet of ${fleet.nodes.length - fleet.projects.length} sessions; the spawn log on the right lists them`}
        onWheel={(e) => {
          const rect = ref.current!.getBoundingClientRect()
          const mx = e.clientX - rect.left
          const my = e.clientY - rect.top
          const k = Math.min(40, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)))
          setView({ k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k })
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d !== undefined) {
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
            if (d.moved) {
              setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
              drag.current = { x: e.clientX, y: e.clientY, moved: true }
            }
            return
          }
          const id = hit(e.clientX, e.clientY)
          const rect = ref.current!.getBoundingClientRect()
          setHover(id === undefined ? undefined : { id, x: e.clientX - rect.left, y: e.clientY - rect.top })
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = undefined
          if (d !== undefined && !d.moved) onSelect(hit(e.clientX, e.clientY))
        }}
        onPointerLeave={() => setHover(undefined)}
      />
      {hoverNode !== undefined && hover !== undefined && (
        <div className="fleet__tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <span className="tag" style={{ color: colorOf(hoverNode.type) }}>{hoverNode.type}{hoverNode.failed === true ? " · failed" : ""}</span>
          <div>{hoverNode.label ?? projectName(hoverNode.project)}</div>
          <div className="muted mono">{shortDate(hoverNode.start)} {timeLabel(hoverNode.start)} → {shortDate(hoverNode.end)} {timeLabel(hoverNode.end)}</div>
        </div>
      )}
      <p className="fleet__hint">
        scroll to zoom · drag to pan · click {fleet.scope === "session" ? "an agent or step" : "a session"} to trace it · space play/pause · ← → step
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const useTitles = (ids: ReadonlyArray<string>) => {
  const [titles, setTitles] = useState<Readonly<Record<string, string | null>>>({})
  const key = ids.join("|")
  useEffect(() => {
    const missing = ids.filter((id) => !(id in titles))
    if (missing.length === 0) return
    let live = true
    fetchTitles(missing).then((got) => live && setTitles((current) => ({ ...current, ...got })), () => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return titles
}

const nameOf = (n: FleetNode, titles: Readonly<Record<string, string | null>>) =>
  n.label ?? titles[n.id] ?? (n.parentId !== undefined ? `${n.type} subagent` : `untitled ${n.type} session`)

const SpawnLog = memo((
  { spawned, family, colorOf, nodeById, onSelect }: {
    spawned: ReadonlyArray<FleetNode>
    family: boolean
    colorOf: (type: string) => string
    nodeById: ReadonlyMap<string, FleetNode>
    onSelect: (id: string) => void
  }
) => {
  const shown = spawned.slice(0, 30)
  // A session's own fleet already knows every title; the full fleet fetches them as needed.
  const titles = useTitles(
    family ? [] : [...new Set(shown.flatMap((n) => (n.parentId !== undefined ? [n.id, n.parentId] : [n.id])))]
  )
  return (
    <div className="fleet__card fleet__log">
      <span className="eyebrow">{family ? "Step log" : "Spawn log"}</span>
      <ol>
        {shown.map((n) => {
          const parent = n.parentId !== undefined ? nodeById.get(n.parentId) : undefined
          return (
            <li key={n.id}>
              <button className="plain" onClick={() => onSelect(n.id)}>
                <span className="fleet__log-head">
                  <span className="tag" style={{ color: family && n.kind === "session" ? AGENT : colorOf(n.type) }}>{n.type}</span>
                  <span className="muted mono">{shortDate(n.start)} · {timeLabel(n.start)}</span>
                </span>
                <span className="fleet__log-title clip">{nameOf(n, titles)}</span>
                <span className={`clip ${n.failed === true ? "is-failed" : "muted"}`}>
                  ↳ {n.kind === "step"
                    ? `${n.failed === true ? "failed · " : ""}by ${parent !== undefined ? nameOf(parent, titles) : "an agent"}`
                    : parent !== undefined
                    ? `spawned by ${nameOf(parent, titles)}`
                    : `in ${projectName(n.project)}`}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {spawned.length === 0 && <p className="muted">Nothing has started yet at this point in time.</p>}
    </div>
  )
})

const SelectedCard = (
  { node, fleet, colorOf, nodeById, onSelect }: {
    node: FleetNode
    fleet: Fleet
    colorOf: (type: string) => string
    nodeById: ReadonlyMap<string, FleetNode>
    onSelect: (id: string | undefined) => void
  }
) => {
  const titles = useTitles(fleet.scope === "session" ? [] : node.parentId !== undefined ? [node.id, node.parentId] : [node.id])
  const children = fleet.nodes.filter((n) => n.parentId === node.id && n.kind === "session")
  const stepCount = fleet.nodes.filter((n) => n.parentId === node.id && n.kind === "step").length
  const parent = node.parentId !== undefined ? nodeById.get(node.parentId) : undefined
  return (
    <div className="fleet__card fleet__selected">
      <div className="fleet__log-head">
        <span className="tag" style={{ color: colorOf(node.type) }}>{node.type}</span>
        <button className="ghost" onClick={() => onSelect(undefined)} aria-label="Clear selection">×</button>
      </div>
      <h3>{nameOf(node, titles)}</h3>
      <p className="muted">
        {projectName(node.project)} · {shortDate(node.start)} {timeLabel(node.start)} → {shortDate(node.end)} {timeLabel(node.end)}
      </p>
      {parent !== undefined && (
        <button className="link" onClick={() => onSelect(parent.id)}>
          ↳ {node.kind === "step" ? "by" : "spawned by"} {nameOf(parent, titles)}
        </button>
      )}
      {children.length > 0 && <p className="muted">Spawned {children.length} subagent{children.length === 1 ? "" : "s"}</p>}
      {stepCount > 0 && <p className="muted">{stepCount} step{stepCount === 1 ? "" : "s"}</p>}
      {node.failed === true && <p className="is-failed">This check failed.</p>}
      {node.kind === "step"
        ? <a className="primary fleet__open" href={sessionHref(node.sessionId!, `/scene/${node.sceneId}`)}>Open this scene →</a>
        : (
          <p className="fleet__links">
            <a className="primary fleet__open" href={sessionHref(node.id)}>Open replay →</a>
            {fleet.scope === "all" && <> <a href={formatRoute({ page: "fleet", session: node.id })}>Its fleet →</a></>}
          </p>
        )}
    </div>
  )
}

/** Sessions working over time, stacked by type; click to move the playhead. */
const ActivityStrip = (
  { fleet, axis, t, colorOf, onSeek }: {
    fleet: Fleet
    axis: TimeAxis
    t: number
    colorOf: (type: string) => string
    onSeek: (t: number) => void
  }
) => {
  const BUCKETS = 180
  const bins = useMemo(() => histogram(fleet, BUCKETS, axis), [fleet, axis])
  const peak = Math.max(1, ...bins.map((b) => [...b.values()].reduce((a, c) => a + c, 0)))
  const [hover, setHover] = useState<number | undefined>()
  const at = (i: number) => axis.time(i / (BUCKETS - 1))
  const inGap = (m: number) => axis.gaps.some((g) => m > g.start && m < g.end)
  // Date ticks: months over long spans, hours over a single session. None inside a collapsed gap.
  const long = fleet.end - fleet.start > 3 * DAY
  const ticks: Array<number> = []
  if (long) {
    for (let d = new Date(fleet.start); d.getTime() <= fleet.end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
      if (first >= fleet.start && !inGap(first)) ticks.push(first)
    }
  } else {
    const hour = 3_600_000
    for (let h = Math.ceil(fleet.start / hour) * hour; h <= fleet.end; h += hour) if (!inGap(h)) ticks.push(h)
  }
  // Ticks closer than 4% of the strip would overlap; keep the first of each cluster.
  const spaced = ticks.filter((m, i) => i === 0 || axis.at(m) - axis.at(ticks[i - 1]!) > 0.04)
  // The bars depend only on the fleet; per frame only the playhead and the dimmer move.
  const bars = useMemo(() => {
    const types = fleet.types.map((x) => x.type)
    return bins.flatMap((bin, i) => {
      let y = 40
      return types.flatMap((type) => {
        const count = bin.get(type) ?? 0
        if (count === 0) return []
        const h = (count / peak) * 36
        y -= h
        return [<rect key={`${i}-${type}`} x={i + 0.1} y={y} width={0.8} height={h} fill={colorOf(type)} />]
      })
    })
  }, [bins, peak, fleet, colorOf])
  const progress = axis.at(t)
  return (
    <div
      className="fleet__strip"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        setHover(Math.min(BUCKETS - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * BUCKETS))))
      }}
      onPointerLeave={() => setHover(undefined)}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onSeek(axis.time((e.clientX - rect.left) / rect.width))
      }}
      role="slider"
      aria-label="Point in time"
      aria-valuemin={fleet.start}
      aria-valuemax={fleet.end}
      aria-valuenow={t}
      aria-valuetext={dateLabel(t)}
      tabIndex={0}
    >
      <svg viewBox={`0 0 ${BUCKETS} 40`} preserveAspectRatio="none" aria-hidden="true">{bars}</svg>
      <div className="fleet__future" style={{ left: `${progress * 100}%` }} />
      {spaced.map((m) => (
        <span key={m} className="fleet__month" style={{ left: `${axis.at(m) * 100}%` }}>{long ? shortDate(m) : timeLabel(m)}</span>
      ))}
      {axis.gaps.map((g) => (
        <span
          key={g.start}
          className="fleet__gap"
          style={{ left: `${g.x * 100}%` }}
          title={`${formatDuration(g.end - g.start)} quiet, trimmed`}
        >
          ⋯
        </span>
      ))}
      <div className="fleet__playhead" style={{ left: `${progress * 100}%` }} />
      {hover !== undefined && (
        <div className="fleet__tooltip fleet__strip-tip" style={{ left: `${(hover / BUCKETS) * 100}%` }}>
          <div>{dateLabel(at(hover))}</div>
          {[...bins[hover]!].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([type, n]) => (
            <div key={type} className="mono"><i style={{ background: colorOf(type) }} /> {type} {n}</div>
          ))}
          {bins[hover]!.size === 0 && <div className="muted">no sessions working</div>}
        </div>
      )}
    </div>
  )
}
