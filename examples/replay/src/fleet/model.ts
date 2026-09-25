import type { EventId, SessionDescriptor } from "@agentbridge/schema"
import { basename } from "../replay/files.ts"
import type { ReplaySession } from "../replay/model.ts"

/**
 * Fleet: every session Bridge lists, as one picture over time. Built from session
 * descriptors alone (a cheap listing, no session is read), so it opens instantly.
 *
 *   node   = a session, sized by its source size
 *   link   = a spawn: `parentSessionId`, from subagent to parent
 *   hub    = a project; top-level sessions attach to their project's hub
 *   type   = the subagent's label, else the harness that ran it
 *   active = between the session's start and its last update
 *
 * A session's own fleet (`buildSessionFleet`) is its family instead: the root session,
 * every subagent below it, and each one's scenes as steps around it.
 */

export interface FleetNode {
  readonly id: string
  readonly kind: "session" | "project" | "step"
  readonly harness?: string | undefined
  readonly project: string
  readonly parentId?: string | undefined
  readonly type: string
  readonly start: number
  readonly end: number
  readonly size: number
  /** Steps: the scene title, the session it belongs to, and whether its check failed. */
  readonly label?: string | undefined
  readonly sessionId?: string | undefined
  readonly sceneId?: string | undefined
  readonly failed?: boolean | undefined
  /** Moments something was recorded, when known (a step's event times). */
  readonly activity?: ReadonlyArray<number> | undefined
}

export interface FleetLink {
  readonly source: string
  readonly target: string
  readonly kind: "spawn" | "project" | "step"
}

export interface Fleet {
  /** Every listed session, or one session's family and its steps. */
  readonly scope: "all" | "session"
  readonly nodes: ReadonlyArray<FleetNode>
  readonly links: ReadonlyArray<FleetLink>
  /** Types by number of sessions, most first. */
  readonly types: ReadonlyArray<{ readonly type: string; readonly count: number }>
  readonly projects: ReadonlyArray<string>
  readonly start: number
  readonly end: number
  readonly subagents: number
  readonly harnesses: number
}

const NO_PROJECT = "(no project)"

export const projectOf = (d: Pick<SessionDescriptor, "projectPath">): string => d.projectPath ?? NO_PROJECT

export const buildFleet = (
  descriptors: ReadonlyArray<SessionDescriptor>,
  harnessNames: ReadonlyMap<string, string>,
  project?: string
): Fleet => {
  const byId = new Map(descriptors.map((d) => [d.id as string, d]))
  // A project view keeps its sessions and any parent they were spawned from, so trees stay whole.
  const selected = project === undefined ? descriptors : descriptors.filter((d) => projectOf(d) === project)
  const keep = new Map<string, SessionDescriptor>()
  for (const d of selected) {
    keep.set(d.id, d)
    let parent = d.parentSessionId !== undefined ? byId.get(d.parentSessionId) : undefined
    while (parent !== undefined && !keep.has(parent.id)) {
      keep.set(parent.id, parent)
      parent = parent.parentSessionId !== undefined ? byId.get(parent.parentSessionId) : undefined
    }
  }

  const sessions: Array<FleetNode> = [...keep.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((d) => {
      const end = Date.parse(d.updatedAt ?? d.startedAt ?? "") || 0
      const start = Date.parse(d.startedAt ?? d.updatedAt ?? "") || end
      return {
        id: d.id,
        kind: "session",
        harness: d.harness,
        project: projectOf(d),
        parentId: d.parentSessionId !== undefined && keep.has(d.parentSessionId) ? d.parentSessionId : undefined,
        type: d.agentLabel ?? harnessNames.get(d.harness) ?? d.harness,
        start,
        end: Math.max(start, end),
        size: d.sizeBytes ?? 20_000
      }
    })

  const projects = [...new Set(sessions.map((n) => n.project))].sort()
  const hubs: Array<FleetNode> = projects.map((p) => {
    const members = sessions.filter((n) => n.project === p)
    const start = Math.min(...members.map((n) => n.start))
    return { id: `project:${p}`, kind: "project", project: p, type: "project", start, end: Math.max(...members.map((n) => n.end)), size: 0 }
  })

  const links: Array<FleetLink> = sessions.map((n) =>
    n.parentId !== undefined
      ? { source: n.id, target: n.parentId, kind: "spawn" as const }
      : { source: n.id, target: `project:${n.project}`, kind: "project" as const }
  )

  const typeCounts = new Map<string, number>()
  for (const n of sessions) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1)
  const times = sessions.flatMap((n) => (n.start > 0 ? [n.start, n.end] : []))
  return {
    scope: "all",
    nodes: [...hubs, ...sessions],
    links,
    types: [...typeCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    projects,
    start: times.length > 0 ? Math.min(...times) : 0,
    end: times.length > 0 ? Math.max(...times) : 0,
    subagents: sessions.filter((n) => n.parentId !== undefined).length,
    harnesses: new Set(sessions.map((n) => n.harness)).size
  }
}

/** Sessions working at time `t`: started, and not yet past their last update. */
export const activeAt = (fleet: Fleet, t: number): ReadonlyArray<FleetNode> =>
  fleet.nodes.filter((n) => n.kind === "session" && n.start <= t && t <= n.end)

/** Sessions and steps started by time `t`, newest first: the log. */
export const spawnedBy = (fleet: Fleet, t: number): ReadonlyArray<FleetNode> =>
  fleet.nodes.filter((n) => n.kind !== "project" && n.start <= t).sort((a, b) => b.start - a.start || a.id.localeCompare(b.id))

/** The session a node's family grows from: follow parents to the top. */
export const rootOf = (descriptors: ReadonlyArray<SessionDescriptor>, id: string): string => {
  const byId = new Map(descriptors.map((d) => [d.id as string, d]))
  let at = byId.get(id)
  while (at?.parentSessionId !== undefined && byId.has(at.parentSessionId)) at = byId.get(at.parentSessionId)
  return at?.id ?? id
}

/** Everything spawned below `root`, root included, in spawn order. */
export const familyOf = (descriptors: ReadonlyArray<SessionDescriptor>, root: string): ReadonlyArray<SessionDescriptor> => {
  const children = new Map<string, Array<SessionDescriptor>>()
  for (const d of descriptors) {
    if (d.parentSessionId !== undefined) children.set(d.parentSessionId, [...(children.get(d.parentSessionId) ?? []), d])
  }
  const out: Array<SessionDescriptor> = []
  const walk = (d: SessionDescriptor) => {
    out.push(d)
    for (const c of children.get(d.id) ?? []) walk(c)
  }
  const top = descriptors.find((d) => d.id === root)
  if (top !== undefined) walk(top)
  return out
}

/** Scene kinds as step types. A check keeps its type whatever the outcome; failure is a separate mark. */
const stepType: Record<string, string> = {
  read: "read",
  change: "change",
  validate: "check",
  command: "command",
  conversation: "conversation"
}

/** A scene's time: its first and last timestamped events. */
const sceneTimes = (replay: ReplaySession, eventIds: ReadonlyArray<EventId>) => {
  const stamps = eventIds.flatMap((id) => {
    const ts = replay.eventIndex.eventById.get(id)?.timestamp
    return ts !== undefined ? [Math.floor(Date.parse(ts) / 1000) * 1000] : []
  })
  return stamps.length > 0
    ? { start: Math.min(...stamps), end: Math.max(...stamps), times: [...new Set(stamps)].sort((a, b) => a - b) }
    : {}
}

/** One agent of a family, from its derived replay: its title and its scenes as steps. */
export const familyMember = (replay: ReplaySession): FamilyMember => ({
  title: replay.title,
  scenes: replay.scenes.map((scene) => ({
    id: scene.id,
    kind: scene.kind,
    title: scene.title,
    eventCount: scene.eventIds.length,
    failed: scene.outcome === "failed",
    ...sceneTimes(replay, scene.eventIds)
  }))
})

/** What a session's family needs from each derived replay: its scenes and their times. */
export interface FamilyMember {
  readonly scenes: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly title: string
    readonly eventCount: number
    readonly start?: number | undefined
    readonly end?: number | undefined
    readonly failed: boolean
    /** Distinct event times, to the second, so the timeline knows when work happened. */
    readonly times?: ReadonlyArray<number> | undefined
  }>
  readonly title?: string | undefined
}

/**
 * A session's own fleet: its family of agents, each with its scenes as steps. Steps link
 * to their agent, subagents to the agent that spawned them.
 */
export const buildSessionFleet = (
  family: ReadonlyArray<SessionDescriptor>,
  members: ReadonlyMap<string, FamilyMember>,
  harnessNames: ReadonlyMap<string, string>
): Fleet => {
  const ids = new Set(family.map((d) => d.id as string))
  const sessions: Array<FleetNode> = family.map((d) => {
    const member = members.get(d.id)
    const times = (member?.scenes ?? []).flatMap((s) => [s.start, s.end]).filter((x): x is number => x !== undefined)
    // Recorded event times win: a listing's `updatedAt` is the file's modification time,
    // which can be hours after the last thing the session did.
    const listedEnd = Date.parse(d.updatedAt ?? d.startedAt ?? "") || 0
    const listedStart = Date.parse(d.startedAt ?? d.updatedAt ?? "") || listedEnd
    const start = times.length > 0 ? Math.min(...times) : listedStart
    const end = times.length > 0 ? Math.max(...times) : Math.max(start, listedEnd)
    return {
      id: d.id,
      kind: "session",
      harness: d.harness,
      project: projectOf(d),
      parentId: d.parentSessionId !== undefined && ids.has(d.parentSessionId) ? d.parentSessionId : undefined,
      type: d.agentLabel ?? harnessNames.get(d.harness) ?? d.harness,
      start,
      end,
      size: d.sizeBytes ?? 20_000,
      label: member?.title
    }
  })
  const steps: Array<FleetNode> = family.flatMap((d) => {
    const owner = sessions.find((s) => s.id === d.id)!
    return (members.get(d.id)?.scenes ?? []).map((scene) => {
      const start = scene.start ?? owner.start
      return {
        id: `${d.id}#${scene.id}`,
        kind: "step" as const,
        project: owner.project,
        parentId: d.id,
        type: stepType[scene.kind] ?? scene.kind,
        start,
        end: Math.max(start, scene.end ?? start),
        size: scene.eventCount,
        label: scene.title,
        sessionId: d.id,
        sceneId: scene.id,
        failed: scene.failed,
        activity: scene.times
      }
    })
  })
  const links: Array<FleetLink> = [
    ...sessions.flatMap((s) => (s.parentId !== undefined ? [{ source: s.id, target: s.parentId, kind: "spawn" as const }] : [])),
    ...steps.map((s) => ({ source: s.id, target: s.parentId!, kind: "step" as const }))
  ]
  // Types here are step kinds: agents are the labelled hubs, so color is left to the work.
  const typeCounts = new Map<string, number>()
  for (const n of steps) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1)
  const times = [...sessions, ...steps].flatMap((n) => (n.start > 0 ? [n.start, n.end] : []))
  return {
    scope: "session",
    nodes: [...sessions, ...steps],
    links,
    types: [...typeCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    projects: [],
    start: times.length > 0 ? Math.min(...times) : 0,
    end: times.length > 0 ? Math.max(...times) : 0,
    subagents: sessions.filter((n) => n.parentId !== undefined).length,
    harnesses: new Set(sessions.map((n) => n.harness)).size
  }
}

/** The nodes whose activity the timeline shows: sessions, or steps in a session's own fleet. */
const counted = (fleet: Fleet) => fleet.nodes.filter((n) => n.kind === (fleet.scope === "session" ? "step" : "session") && n.start > 0)

/**
 * A time axis with the dead time trimmed. Stretches where nothing works, longer than a small
 * share of the span, collapse to a thin break, so the strip and playback spend their length on
 * activity. Positions run from 0 to 1; real times are kept for everything shown as a date.
 */
export interface TimeAxis {
  /** Real time → position on the strip, 0…1. */
  readonly at: (t: number) => number
  /** Position on the strip → real time. */
  readonly time: (x: number) => number
  /** The collapsed stretches, with where each sits on the strip. */
  readonly gaps: ReadonlyArray<{ readonly start: number; readonly end: number; readonly x: number }>
}

const DAY_MS = 86_400_000

/** A quiet stretch collapses when longer than this share of the span. */
const GAP_SHARE = 0.02
/** The share of the trimmed strip each collapsed stretch keeps: enough to show a break. */
const KEEP_SHARE = 0.015

export const timeAxis = (fleet: Fleet): TimeAxis => {
  const span = Math.max(1, fleet.end - fleet.start)
  // Busy intervals, from evidence of activity: a step's event times when known; otherwise a
  // span shorter than a day counts whole (likely continuous work), while a longer one, usually
  // a session resumed days later, counts only around its start and end.
  const threshold = span * GAP_SHARE
  const intervals = counted(fleet).flatMap((n): Array<readonly [number, number]> => {
    if (n.activity !== undefined && n.activity.length > 0) return n.activity.map((a) => [a, a] as const)
    if (n.end - n.start <= DAY_MS) return [[n.start, n.end]]
    return [[n.start, n.start + threshold / 2], [n.end - threshold / 2, n.end]]
  }).sort((a, b) => a[0] - b[0])
  const busy: Array<[number, number]> = []
  for (const [s, e] of intervals) {
    const last = busy.at(-1)
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e)
    else busy.push([s, e])
  }
  const gaps: Array<{ start: number; end: number }> = []
  for (let i = 1; i < busy.length; i++) {
    const [start, end] = [busy[i - 1]![1], busy[i]![0]]
    if (end - start > threshold) gaps.push({ start, end })
  }
  // Each gap keeps KEEP_SHARE of the *trimmed* length, however long the original span:
  // with kept time k per gap, k / (remaining + n·k) = share, so k = share · remaining / (1 − n · share).
  const share = Math.min(KEEP_SHARE, 0.5 / Math.max(1, gaps.length))
  const remaining = span - gaps.reduce((sum, g) => sum + (g.end - g.start), 0)
  const keepFor = (g: { start: number; end: number }) =>
    Math.min(g.end - g.start, (share * Math.max(remaining, 1)) / (1 - gaps.length * share))
  // Piecewise-linear: inside a gap, time runs `keep / gap` as fast.
  const removedBefore = (t: number) =>
    gaps.reduce((sum, g) => sum + (t <= g.start ? 0 : Math.max(0, Math.min(t, g.end) - g.start) * (1 - keepFor(g) / (g.end - g.start))), 0)
  const length = Math.max(1, span - removedBefore(fleet.end))
  const at = (t: number) => Math.min(1, Math.max(0, (t - fleet.start - removedBefore(t)) / length))
  const time = (x: number) => {
    // Invert by bisection: `at` is monotonic, and 40 halvings are exact to well under a second.
    let lo = fleet.start
    let hi = fleet.end
    const target = Math.min(1, Math.max(0, x))
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (at(mid) < target) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  return { at, time, gaps: gaps.map((g) => ({ ...g, x: at(g.start) })) }
}

/**
 * Activity per strip bucket, split by type: how many sessions (or steps) were working. Buckets
 * follow the trimmed axis, so collapsed dead time takes almost no room.
 */
export const histogram = (fleet: Fleet, buckets: number, axis: TimeAxis = timeAxis(fleet)): ReadonlyArray<ReadonlyMap<string, number>> => {
  const out = Array.from({ length: buckets }, () => new Map<string, number>())
  for (const n of counted(fleet)) {
    const first = Math.floor(axis.at(n.start) * (buckets - 1))
    const last = Math.floor(axis.at(n.end) * (buckets - 1))
    for (let b = first; b <= last; b++) out[b]!.set(n.type, (out[b]!.get(n.type) ?? 0) + 1)
  }
  return out
}

/** A readable project name: `~` for a home directory, shortened UUID-like workspace names. */
export const projectName = (project: string): string => {
  if (project === NO_PROJECT) return project
  if (/^\/(Users|home)\/[^/]+\/?$/.test(project)) return "~"
  const name = basename(project.replace(/\/$/, ""))
  return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(name) ? `${name.slice(0, 8)}…` : name
}
