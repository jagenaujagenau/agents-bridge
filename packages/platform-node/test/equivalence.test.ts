import { Bridge } from "@agentbridge/core"
import type { SessionEvent } from "@agentbridge/schema"
import {
  checkEventInvariants,
  fixtureBridgeOptions,
  scenario,
  semanticProjection,
  type SemanticStep
} from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { NodeBridge } from "../src/index.ts"

/** Every harness root points at sanitized fixtures; nothing on this machine is read. */
const fixtureLayer = NodeBridge.layer(fixtureBridgeOptions)

/** Everything a consumer needs, obtained only through the provider-agnostic Bridge API. */
const view = (id: string) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const { session, warnings } = yield* bridge.sessions.get(id)
    const events = yield* Stream.runCollect(bridge.sessions.events(id))
    return { session, warnings, events }
  })

const withoutCommands = (steps: ReadonlyArray<SemanticStep>) => steps.filter((step) => step[0] !== "command")

const primaries = [scenario.claude, scenario.codex, scenario.pi, scenario.opencode, scenario.gemini, scenario.cursor, scenario.antigravity, scenario.acp]
const subagents = [scenario.claudeSubagent, scenario.codexSubagent, scenario.piSubagent, scenario.opencodeSubagent, scenario.cursorSubagent]

describe("every harness yields the same primitives for the same work (spec §63)", () => {
  it.effect("the reference scenario, exactly", () =>
    Effect.gen(function*() {
      const { events, session } = yield* view(scenario.claude)
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Add a Usage section to README.md and make sure the tests pass."],
        ["read", "README.md"],
        ["changed", "README.md"],
        ["command", "npm test", "failed"],
        ["created", "docs/usage.md"],
        ["command", "npm test", "succeeded"],
        ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
      ])
      const codex = yield* view(scenario.codex)
      expect(semanticProjection(codex.session, codex.events)).toEqual(semanticProjection(session, events))
    }).pipe(Effect.provide(fixtureLayer)))

  it.effect.each(primaries.slice(1))("%s matches the reference", (id) =>
    Effect.gen(function*() {
      const reference = yield* view(scenario.claude)
      const candidate = yield* view(id)
      const expected = semanticProjection(reference.session, reference.events, { writes: "coarse" })
      const actual = semanticProjection(candidate.session, candidate.events, { writes: "coarse" })
      // Capability-driven, not harness-driven: without recorded tool results there are no command outcomes.
      expect(actual).toEqual(candidate.session.capabilities.toolResults ? expected : withoutCommands(expected))
    }).pipe(Effect.provide(fixtureLayer)))

  it.effect.each(subagents)("%s is linked to its parent and matches the other subagents", (id) =>
    Effect.gen(function*() {
      const reference = yield* view(scenario.claudeSubagent)
      const candidate = yield* view(id)
      expect(candidate.session.parentSessionId).toBeDefined()
      expect(withoutCommands(semanticProjection(candidate.session, candidate.events)))
        .toEqual(withoutCommands(semanticProjection(reference.session, reference.events)))
    }).pipe(Effect.provide(fixtureLayer)))

  it.effect.each([...primaries, ...subagents])("%s satisfies the structural invariants", (id) =>
    Effect.gen(function*() {
      expect(checkEventInvariants((yield* view(id)).events)).toEqual([])
    }).pipe(Effect.provide(fixtureLayer)))

  it.effect.each(primaries)("%s carries the same useful session metadata", (id) =>
    Effect.gen(function*() {
      const { session } = yield* view(id)
      expect(session).toMatchObject({ projectPath: "/work/demo", status: "unknown" })
      expect(session.title).toMatch(/README/)
      expect(session.startedAt?.startsWith("2026-09-01T10:00")).toBe(true)
    }).pipe(Effect.provide(fixtureLayer)))

  it.effect("generic views agree across harnesses that record tool results", () =>
    Effect.gen(function*() {
      const summarize = (events: ReadonlyArray<SessionEvent>) => ({
        editTools: events.filter((e) => e.type === "tool.started" && e.kind === "edit").length,
        executeTools: events.filter((e) => e.type === "tool.started" && e.kind === "execute").length > 0,
        commandsLinkedToTools: events.filter((e) => e.type === "command.completed").every((e) => e.parentEventId !== undefined)
      })
      const reference = summarize((yield* view(scenario.claude)).events)
      for (const id of [scenario.pi, scenario.opencode, scenario.gemini, scenario.antigravity]) {
        expect(summarize((yield* view(id)).events), id).toEqual(reference)
      }
    }).pipe(Effect.provide(fixtureLayer)))

  it.effect("all sessions list through one registry and every harness is detected", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const ids = (yield* Stream.runCollect(bridge.sessions.list())).map((d) => d.id).sort()
      expect(ids).toEqual(Object.values(scenario).sort())
      const detected = yield* bridge.harnesses.detect
      expect(detected.map((d) => [d.harness, d.historyAvailable])).toEqual([
        ["claude-code", true],
        ["codex", true],
        ["opencode", true],
        ["pi", true],
        ["gemini-cli", true],
        ["cursor", true],
        ["antigravity", true],
        ["acp", true]
      ])
    }).pipe(Effect.provide(fixtureLayer)))
})
