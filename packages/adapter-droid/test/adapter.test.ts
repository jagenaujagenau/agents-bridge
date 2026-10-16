import { Bridge, HostEnvironment, sequenceEvents } from "@agentbridge/core"
import { makeSessionId } from "@agentbridge/schema"
import {
  adapterContract,
  bridgeWithAdapter,
  checkEventInvariants,
  expectGolden,
  fixturesDir,
  semanticProjection
} from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { decodeLine, initialState, normalizeLine } from "../src/DroidNormalizer.ts"
import { classifyDroidFile, DroidAdapter, executeStatus, todoEntries } from "../src/index.ts"

/** The §63 scenario recorded by Factory Droid (see generate-fixture.ts). */
const scenario = {
  droid: "droid:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  droidSubagent: "droid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
} as const

/** FACTORY_HOME_OVERRIDE replaces HOME; the fixture keeps `.factory` beneath it. */
const droidFixtureHome = `${fixturesDir}droid`

const layer = bridgeWithAdapter(
  DroidAdapter,
  DroidAdapter.layer,
  HostEnvironment.layer({ FACTORY_HOME_OVERRIDE: droidFixtureHome })
)

adapterContract({
  harness: "droid",
  layer,
  expectedSessions: [scenario.droid, scenario.droidSubagent],
  damagedSession: scenario.droid
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("droid golden files", () => {
  it.effect("scenario session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.droid)))
    }).pipe(Effect.provide(layer)))

  it.effect("subagent session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.droidSubagent)))
    }).pipe(Effect.provide(layer)))
})

describe("droid normalization", () => {
  it.effect("session metadata", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.droid)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        harness: { id: "droid", name: "Factory Droid" },
        startedAt: "2026-09-01T10:00:01.000Z",
        status: "unknown",
        metadata: { model: "claude-opus-5", sessionFormatVersion: 2 }
      })
      expect(session.capabilities.tokenUsage).toBe(false)
      const sub = yield* bridge.sessions.get(scenario.droidSubagent)
      expect(sub.session).toMatchObject({ parentSessionId: scenario.droid, title: "Find TODO comments" })
    }).pipe(Effect.provide(layer)))

  it.effect("produces the reference scenario", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.droid)
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.droid))
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Add a Usage section to README.md and make sure the tests pass."],
        ["read", "README.md"],
        ["changed", "README.md"],
        ["command", "npm test", "failed"],
        ["created", "docs/usage.md"],
        ["command", "npm test", "succeeded"],
        ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
      ])
      expect(events.filter((e) => e.type === "user.message")).toHaveLength(1)
      expect(events.find((e) => e.type === "harness.notice")).toMatchObject({ kind: "injected_context" })
      const commands = events.filter((e) => e.type === "command.completed")
      expect(commands).toMatchObject([{ outcome: "failed", exitCode: 1 }, { outcome: "succeeded", exitCode: 0 }])
      expect(events.some((e) => e.type === "usage.recorded")).toBe(false)
    }).pipe(Effect.provide(layer)))

  it.effect("agent_turn_outcome ends the turn it names", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.droidSubagent))
      expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => [e.type, e.certainty]))
        .toEqual([["turn.started", "known"], ["turn.completed", "known"]])
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", outcome: "completed", turnId: "m001-user" })
    }).pipe(Effect.provide(layer)))

  it("discovers sessions and skips sidecars and attachments", () => {
    const id = "11111111-1111-4111-8111-111111111111"
    expect(classifyDroidFile(["-Users-d-x", `${id}.jsonl`], "/x")?.nativeId).toBe(id)
    expect(classifyDroidFile(["btw", `${id}.jsonl`], "/x")?.nativeId).toBe(id)
    expect(classifyDroidFile([`${id}.jsonl`], "/x")?.nativeId).toBe(id)
    expect(classifyDroidFile(["-Users-d-x", `${id}.settings.json`], "/x")).toBeUndefined()
    expect(classifyDroidFile([id, "attachments", "a.jsonl"], "/x")).toBeUndefined()
  })

  it("reads exit codes only from the result text", () => {
    expect(executeStatus("out\n[Process exited with code 2]", true)).toEqual({ outcome: "failed", exitCode: 2 })
    expect(executeStatus("Command failed (exit code: 1)\nboom", false)).toEqual({ outcome: "failed", exitCode: 1 })
    expect(executeStatus("ok", false)).toEqual({ outcome: "succeeded" })
    expect(executeStatus("Command timed out after 60 seconds.", true)).toEqual({ outcome: "interrupted" })
  })

  it("parses Droid's numbered todo lines", () => {
    expect(todoEntries({ todos: "1. [completed] Read README\n2. [in_progress] Edit README\n3. [pending] Run tests" })).toEqual([
      { content: "Read README", status: "completed" },
      { content: "Edit README", status: "in_progress" },
      { content: "Run tests", status: "pending" }
    ])
    const array = [{ id: "1", content: "x", status: "pending", priority: "high" }]
    expect(todoEntries({ todos: array })).toBe(array)
  })
})

describe("droid records beyond the scenario", () => {
  const sessionId = makeSessionId("droid", "t")
  const normalize = (records: ReadonlyArray<object>) =>
    Effect.runSync(
      Stream.fromIterable(records.map((r, index) => ({ index, line: JSON.stringify(r) }))).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/t.jsonl"), normalizeLine),
        sequenceEvents(sessionId),
        Stream.runCollect
      )
    )
  const at = (s: number) => `2026-09-01T10:00:0${s}.000Z`
  const user = (id: string, content: unknown, extra: object = {}) =>
    ({ type: "message", id, timestamp: at(0), message: { role: "user", content, ...extra } })
  const assistant = (id: string, content: unknown) => ({ type: "message", id, timestamp: at(1), message: { role: "assistant", content } })

  it("plans come from todo_state, linked to the TodoWrite that produced them", () => {
    const events = normalize([
      user("u1", "plan it"),
      assistant("a1", [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: "1. [in_progress] Edit\n2. [pending] Test" } }]),
      user("u2", [{ type: "tool_result", tool_use_id: "t1", content: "TODO List Updated" }]),
      { type: "todo_state", id: "s1", timestamp: at(2), todos: { todos: [{ id: "1", content: "Edit", status: "in_progress", priority: "high" }, { id: "2", content: "Test", status: "pending", priority: "high" }] }, messageIndex: 1 }
    ])
    const plans = events.filter((e) => e.type === "plan.updated")
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ entries: [{ content: "Edit", status: "in_progress", priority: "high" }, { content: "Test", status: "pending", priority: "high" }] })
    expect(plans[0]?.parentEventId).toBe(events.find((e) => e.type === "tool.started")?.id)
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("compaction, hooks, model-only context and turn outcomes", () => {
    const events = normalize([
      user("u1", "first"),
      { type: "agent_turn_outcome", turnId: "u1", reason: "cancelled", resultKind: "null" },
      user("h1", "hook said hi", { hookEventName: "UserPromptSubmit" }),
      user("l1", "context for the model", { visibility: "llm_only" }),
      { type: "compaction_state", id: "c1", timestamp: at(3), summaryText: "Summary so far", summaryTokens: 10, removedCount: 4 },
      user("u2", "second"),
      { type: "agent_turn_outcome", turnId: "stale", reason: "completed", resultKind: "null" },
      user("u3", "third")
    ])
    expect(events.map((e) => [e.type, "kind" in e ? e.kind : "outcome" in e ? e.outcome : undefined])).toEqual([
      ["session.started", undefined],
      ["turn.started", undefined],
      ["user.message", undefined],
      ["turn.completed", "interrupted"],
      ["harness.notice", "hook"],
      ["harness.notice", "injected_context"],
      ["context.compacted", undefined],
      ["turn.started", undefined],
      ["user.message", undefined],
      ["turn.completed", "unknown"],
      ["turn.started", undefined],
      ["user.message", undefined]
    ])
    expect(events.find((e) => e.type === "context.compacted")).toMatchObject({ summary: "Summary so far" })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("ApplyPatch effects come from its result summary; failed edits have none", () => {
    const events = normalize([
      user("u1", "patch"),
      assistant("a1", [{ type: "tool_use", id: "p1", name: "ApplyPatch", input: { input: "*** Begin Patch\n..." } }]),
      user("r1", [{ type: "tool_result", tool_use_id: "p1", content: "Success. Applied changes to the following files:\nA /w/new.ts\nM /w/old.ts\nD /w/gone.ts\nM /w/a.ts -> /w/b.ts" }]),
      assistant("a2", [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/w/x.ts", old_str: "a", new_str: "b" } }]),
      user("r2", [{ type: "tool_result", tool_use_id: "e1", content: "old_str not found", is_error: true }])
    ])
    expect(events.filter((e) => e.type.startsWith("file.")).map((e) => [e.type, (e as { path: string }).path])).toEqual([
      ["file.created", "/w/new.ts"],
      ["file.changed", "/w/old.ts"],
      ["file.deleted", "/w/gone.ts"],
      ["file.changed", "/w/b.ts"]
    ])
    expect(events.find((e) => e.type === "tool.failed")).toMatchObject({ message: "old_str not found" })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("fork relationships come from session_start.parent", () => {
    const sessionStart = { type: "session_start", id: "t", title: "Forked", owner: "o", parent: "src", forkedAtMessageId: "m9", version: 2, cwd: "/w" }
    const emissions = Effect.runSync(
      Stream.fromIterable([{ index: 0, line: JSON.stringify(sessionStart) }]).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/t.jsonl"), normalizeLine),
        Stream.runCollect
      )
    )
    expect(emissions).toMatchObject([{
      _tag: "Metadata",
      patch: { projectPath: "/w", title: { value: "Forked" }, relationships: [{ type: "fork", from: sessionId, to: "droid:src" }] }
    }])
  })
})
