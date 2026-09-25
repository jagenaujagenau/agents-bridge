import { Bridge } from "@agentbridge/core"
import { NodeBridge } from "@agentbridge/platform-node"
import { fixtureBridgeOptions, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { layoutFleet } from "../src/fleet/layout.ts"
import { fleetSignature } from "../src/fleet/useLayout.ts"
import { type Fleet, type FleetNode, timeAxis } from "../src/fleet/model.ts"
import { activeAt, buildFleet, buildSessionFleet, familyMember, familyOf, histogram, projectName, rootOf, spawnedBy } from "../src/fleet/model.ts"
import { loadReplaySession } from "../src/index.ts"

const layer = NodeBridge.layer(fixtureBridgeOptions)

const listing = Effect.gen(function*() {
  const bridge = yield* Bridge
  const sessions = [...yield* Stream.runCollect(bridge.sessions.list())]
  return { sessions, names: new Map(bridge.harnesses.list.map((h) => [h.id as string, h.name])) }
})

describe("fleet", () => {
  it.effect("links subagents to their parent and top-level sessions to their project", () =>
    Effect.gen(function*() {
      const { sessions, names } = yield* listing
      const fleet = buildFleet(sessions, names)
      const spawn = fleet.links.filter((l) => l.kind === "spawn")
      expect(spawn).toContainEqual({ source: scenario.claudeSubagent, target: scenario.claude, kind: "spawn" })
      expect(spawn).toContainEqual({ source: scenario.codexSubagent, target: scenario.codex, kind: "spawn" })
      // Every session has exactly one outgoing link: to a parent or to its project hub.
      const sessionsOnly = fleet.nodes.filter((n) => n.kind === "session")
      expect(fleet.links).toHaveLength(sessionsOnly.length)
      expect(fleet.subagents).toBe(spawn.length)
      // A subagent's type is its label; a top-level session's is its harness.
      expect(fleet.nodes.find((n) => n.id === scenario.claude)?.type).toBe("Claude Code")
    }).pipe(Effect.provide(layer)))

  it.effect("a project view keeps whole trees", () =>
    Effect.gen(function*() {
      const { sessions, names } = yield* listing
      const child = sessions.find((s) => s.id === scenario.claudeSubagent)!
      const fleet = buildFleet(sessions, names, child.projectPath)
      const ids = fleet.nodes.map((n) => n.id)
      expect(ids).toContain(scenario.claudeSubagent)
      expect(ids).toContain(scenario.claude)
      expect(fleet.projects.every((p) => p === child.projectPath || ids.includes(`project:${p}`))).toBe(true)
    }).pipe(Effect.provide(layer)))

  it.effect("answers what had started and what was working at any time", () =>
    Effect.gen(function*() {
      const { sessions, names } = yield* listing
      const fleet = buildFleet(sessions, names)
      expect(spawnedBy(fleet, fleet.start - 1)).toEqual([])
      expect(spawnedBy(fleet, fleet.end)).toHaveLength(fleet.nodes.filter((n) => n.kind === "session").length)
      for (const n of activeAt(fleet, fleet.end)) expect(n.start <= fleet.end && fleet.end <= n.end).toBe(true)
      const bins = histogram(fleet, 50)
      expect(bins).toHaveLength(50)
      expect([...bins.flatMap((b) => [...b.values()])].every((v) => v > 0)).toBe(true)
    }).pipe(Effect.provide(layer)))

  it.effect("lays out the same fleet in the same place every time", () =>
    Effect.gen(function*() {
      const { sessions, names } = yield* listing
      const fleet = buildFleet(sessions, names)
      expect([...layoutFleet(fleet)]).toEqual([...layoutFleet(fleet)])
      expect(layoutFleet(fleet).size).toBe(fleet.nodes.length)
    }).pipe(Effect.provide(layer)))

  it.effect("a session's own fleet is its family, each agent with its scenes as steps", () =>
    Effect.gen(function*() {
      const { sessions, names } = yield* listing
      // Asking from the subagent opens the whole family from its root.
      const root = rootOf(sessions, scenario.claudeSubagent)
      expect(root).toBe(scenario.claude)
      const family = familyOf(sessions, root)
      expect(family.map((d) => d.id)).toEqual([scenario.claude, scenario.claudeSubagent])

      const members = new Map<string, ReturnType<typeof familyMember>>()
      for (const d of family) members.set(d.id, familyMember(yield* loadReplaySession(d.id)))
      const fleet = buildSessionFleet(family, members, names)
      expect(fleet.scope).toBe("session")

      const rootReplay = yield* loadReplaySession(scenario.claude)
      const rootSteps = fleet.nodes.filter((n) => n.kind === "step" && n.parentId === scenario.claude)
      expect(rootSteps.map((n) => n.label)).toEqual(rootReplay.scenes.map((sc) => sc.title))
      // The failing test run is marked; the passing one is not.
      expect(rootSteps.filter((n) => n.failed === true).map((n) => n.label)).toEqual(["Ran tests → failed"])
      expect(fleet.links).toContainEqual({ source: scenario.claudeSubagent, target: scenario.claude, kind: "spawn" })
      // Types are step kinds only; agents are the hubs.
      expect(fleet.types.map((x) => x.type).sort()).toEqual([...new Set(fleet.nodes.filter((n) => n.kind === "step").map((n) => n.type))].sort())
      // Steps fall inside the family's span, and the strip counts them.
      for (const n of fleet.nodes) expect(n.start >= fleet.start && n.end <= fleet.end).toBe(true)
      expect(histogram(fleet, 10).reduce((sum, b) => sum + [...b.values()].reduce((a, c) => a + c, 0), 0)).toBeGreaterThan(0)
      expect([...layoutFleet(fleet)]).toEqual([...layoutFleet(fleet)])
    }).pipe(Effect.provide(layer)))

  it.effect("the layout cache key changes whenever the fleet's shape does", () =>
    Effect.gen(function*() {
      const { sessions, names } = yield* listing
      const fleet = buildFleet(sessions, names)
      expect(fleetSignature(buildFleet(sessions, names))).toBe(fleetSignature(fleet))
      // One session fewer, or a different project view, is a different layout.
      expect(fleetSignature(buildFleet(sessions.slice(1), names))).not.toBe(fleetSignature(fleet))
      const child = sessions.find((s) => s.id === scenario.claudeSubagent)!
      expect(fleetSignature(buildFleet(sessions, names, child.projectPath))).not.toBe(fleetSignature(fleet))
    }).pipe(Effect.provide(layer)))

  it("trims dead time from the timeline", () => {
    const HOUR = 3_600_000
    const node = (id: string, start: number, end: number): FleetNode => ({
      id, kind: "session", project: "/p", type: "T", start, end, size: 1
    })
    // Two bursts of work an hour long, with ten idle days between them.
    const t0 = Date.UTC(2026, 0, 1)
    const fleet: Fleet = {
      scope: "all",
      nodes: [node("a", t0, t0 + HOUR), node("b", t0 + 240 * HOUR, t0 + 241 * HOUR)],
      links: [], types: [{ type: "T", count: 2 }], projects: [], start: t0, end: t0 + 241 * HOUR, subagents: 0, harnesses: 1
    }
    const axis = timeAxis(fleet)
    expect(axis.gaps).toHaveLength(1)
    expect(axis.gaps[0]).toMatchObject({ start: t0 + HOUR, end: t0 + 240 * HOUR })
    // The ten days shrink to a sliver; each hour of work gets nearly half the strip.
    const gapWidth = axis.at(t0 + 240 * HOUR) - axis.at(t0 + HOUR)
    expect(gapWidth).toBeCloseTo(0.015, 3)
    expect(axis.at(t0 + HOUR)).toBeGreaterThan(0.35)
    // Monotonic, anchored at the ends, and invertible.
    expect(axis.at(t0)).toBe(0)
    expect(axis.at(fleet.end)).toBeCloseTo(1)
    let previous = -1
    for (let i = 0; i <= 100; i++) {
      const x = axis.at(t0 + (i / 100) * (fleet.end - t0))
      expect(x).toBeGreaterThanOrEqual(previous)
      previous = x
    }
    for (const x of [0.1, 0.45, 0.6, 0.9]) expect(axis.at(axis.time(x))).toBeCloseTo(x, 3)
    // Both bursts land in the histogram, at opposite ends.
    const bins = histogram(fleet, 20, axis)
    expect(bins[0]!.get("T")).toBe(1)
    expect(bins[19]!.get("T")).toBe(1)
  })

  it("keeps a steady timeline untouched", () => {
    const HOUR = 3_600_000
    const t0 = Date.UTC(2026, 0, 1)
    const nodes: Array<FleetNode> = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`, kind: "session", project: "/p", type: "T", start: t0 + i * HOUR, end: t0 + (i + 1) * HOUR, size: 1
    }))
    const fleet: Fleet = {
      scope: "all", nodes, links: [], types: [{ type: "T", count: 10 }], projects: [], start: t0, end: t0 + 10 * HOUR, subagents: 0, harnesses: 1
    }
    const axis = timeAxis(fleet)
    expect(axis.gaps).toEqual([])
    expect(axis.at(t0 + 5 * HOUR)).toBeCloseTo(0.5)
  })

  it("names projects readably", () => {
    expect(projectName("/Users/someone")).toBe("~")
    expect(projectName("/work/demo")).toBe("demo")
    expect(projectName("/tmp/9b2f1c3a-1111-4222-8333-444455556666")).toBe("9b2f1c3a…")
  })
})
