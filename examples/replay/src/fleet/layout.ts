import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force"
import type { Fleet } from "./model.ts"

/**
 * Stable fleet geography: a force layout run to rest once and cached, like the code map.
 * Spawn links hold each tree together; top-level sessions hang off their project's hub.
 * d3-force seeds positions deterministically and its jiggle uses a fixed random source,
 * so the same fleet always lands in the same place.
 */

export interface FleetPosition {
  readonly x: number
  readonly y: number
  readonly r: number
}

interface Datum extends SimulationNodeDatum {
  readonly id: string
  readonly r: number
}

/** A seeded linear congruential generator, so layout never depends on Math.random. */
const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296

export const nodeRadius = (kind: "session" | "project" | "step", size: number): number =>
  kind === "project"
    ? 5
    : kind === "step"
    ? Math.max(1.2, Math.min(3.5, 0.8 + Math.log2(Math.max(size, 1)) * 0.45))
    : Math.max(1.6, Math.min(6, Math.log10(Math.max(size, 1000)) - 1.8))

/** Simulation steps after seeding. Measured: 630 sessions settle visibly by here. */
const TICKS = 120

/**
 * Deterministic starting positions: hubs (projects, or agents in a session's own fleet)
 * on a sunflower spiral, larger ones nearer the middle; everything else in a small ring
 * around the node it links to, in link order.
 */
const seedPositions = (fleet: Fleet, nodes: Array<Datum>): void => {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const anchor = new Map(fleet.links.map((l) => [l.source, l.target]))
  const weight = new Map<string, number>()
  for (const l of fleet.links) weight.set(l.target, (weight.get(l.target) ?? 0) + 1)
  const roots = fleet.nodes.filter((n) => !anchor.has(n.id)).map((n) => n.id)
    .sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || (a < b ? -1 : 1))
  const golden = Math.PI * (3 - Math.sqrt(5))
  roots.forEach((id, i) => {
    const node = byId.get(id)!
    const radius = 18 * Math.sqrt(i + 0.5)
    node.x = radius * Math.cos(i * golden)
    node.y = radius * Math.sin(i * golden)
  })
  // Children after their anchor: walk from the roots so every anchor is placed first.
  const children = new Map<string, Array<string>>()
  for (const [child, parent] of anchor) children.set(parent, [...(children.get(parent) ?? []), child])
  const queue = [...roots]
  while (queue.length > 0) {
    const parent = byId.get(queue.shift()!)!
    const kids = children.get(parent.id) ?? []
    kids.forEach((id, i) => {
      const node = byId.get(id)!
      const angle = (i / Math.max(1, kids.length)) * Math.PI * 2
      const ring = 8 + Math.sqrt(kids.length) * 2
      node.x = (parent.x ?? 0) + ring * Math.cos(angle)
      node.y = (parent.y ?? 0) + ring * Math.sin(angle)
      queue.push(id)
    })
  }
}

export const layoutFleet = (fleet: Fleet): ReadonlyMap<string, FleetPosition> => {
  // In a session's own fleet the agents are the hubs; their steps orbit them.
  const family = fleet.scope === "session"
  const hubs = new Set(fleet.nodes.filter((n) => n.kind === "project" || (family && n.kind === "session")).map((n) => n.id))
  const nodes: Array<Datum> = fleet.nodes.map((n) => ({
    id: n.id,
    r: family && n.kind === "session" ? nodeRadius("session", n.size) + 2 : nodeRadius(n.kind, n.size)
  }))
  seedPositions(fleet, nodes)
  const links = fleet.links.map((l) => ({ source: l.source, target: l.target, kind: l.kind }))
  const simulation = forceSimulation(nodes)
    .randomSource(lcg(42))
    .force(
      "link",
      forceLink<Datum, (typeof links)[number]>(links)
        .id((d) => d.id)
        .distance((l) => (l.kind === "spawn" ? (family ? 70 : 10) : l.kind === "step" ? 14 : 22))
        .strength((l) => (l.kind === "spawn" ? 1 : l.kind === "step" ? 0.7 : 0.5))
    )
    .force("charge", forceManyBody<Datum>().strength((d) => (hubs.has(d.id) ? -140 : -9)).distanceMax(260))
    .force("collide", forceCollide<Datum>().radius((d) => d.r + 1.2))
    .force("x", forceX(0).strength(0.035))
    .force("y", forceY(0).strength(0.035))
    .stop()
  // Seeded near their final place, nodes settle in far fewer steps than from d3's default spiral:
  // alpha decays from 1 to its floor over TICKS steps instead of ~300.
  simulation.alphaDecay(1 - Math.pow(simulation.alphaMin(), 1 / TICKS))
  for (let i = 0; i < TICKS; i++) simulation.tick()
  return new Map(nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0, r: n.r }]))
}
