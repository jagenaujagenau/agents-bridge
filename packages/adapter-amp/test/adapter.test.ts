import { Bridge, HostEnvironment } from "@agentbridge/core"
import { makeSessionId } from "@agentbridge/schema"
import { adapterContract, bridgeWithAdapter, expectGolden, fixturesDir, semanticProjection } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { classifyExportFile, classifyThreadFile, inspectHead } from "../src/AmpAdapter.ts"
import { initialState, instant, normalizeMessage, pathFromUri, threadFacts } from "../src/AmpNormalizer.ts"
import { AmpAdapter, ampUsage, patchOperations, shellOutcome } from "../src/index.ts"

/** Sanitized fixtures written by `generate-fixture.ts`. */
export const ampFixtureDataHome = `${fixturesDir}amp/data`
export const ampFixtureExports = `${fixturesDir}amp/exports`

/** The §63 scenario (legacy local thread) and a handoff thread saved with `amp threads export`. */
export const ampScenario = {
  amp: "amp:T-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ampExported: "amp:T-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
} as const

const layer = bridgeWithAdapter(
  AmpAdapter,
  AmpAdapter.layer,
  HostEnvironment.layer({ AMP_DATA_HOME: ampFixtureDataHome, BRIDGE_AMP_EXPORTS: ampFixtureExports })
)

adapterContract({
  harness: "amp",
  layer,
  expectedSessions: [ampScenario.amp, ampScenario.ampExported],
  damagedSession: ampScenario.amp,
  damagedWarnings: ["malformed_record", "unknown_record_type"]
})

const events = (id: string) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    return yield* Stream.runCollect(bridge.sessions.events(id))
  })

describe("amp", () => {
  it.effect("golden files", () =>
    Effect.gen(function*() {
      expectGolden(fileURLToPath(new URL("./golden/scenario.jsonl", import.meta.url)), yield* events(ampScenario.amp))
      expectGolden(fileURLToPath(new URL("./golden/exported.jsonl", import.meta.url)), yield* events(ampScenario.ampExported))
    }).pipe(Effect.provide(layer)))

  it.effect("produces the reference scenario", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(ampScenario.amp)
      expect(semanticProjection(session, yield* events(ampScenario.amp), { writes: "coarse" })).toEqual([
        ["user", "Add a Usage section to README.md and make sure the tests pass."],
        ["read", "README.md"],
        ["written", "README.md"],
        ["command", "npm test", "failed"],
        ["written", "docs/usage.md"],
        ["command", "npm test", "succeeded"],
        ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
      ])
    }).pipe(Effect.provide(layer)))

  it.effect("reads thread metadata and relationships", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(ampScenario.amp)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:00.000Z",
        harness: { id: "amp", version: "0.0.1774959077-ga71644" },
        metadata: { model: "claude-opus-4-6", agentMode: "smart" },
        relationships: [{ type: "resume", from: ampScenario.ampExported, to: ampScenario.amp }]
      })
      const exported = yield* bridge.sessions.get(ampScenario.ampExported)
      expect(exported.session).toMatchObject({
        title: "Summarize README change",
        startedAt: "2026-09-01T10:00:20.000Z",
        relationships: [{ type: "resume", from: ampScenario.ampExported, to: ampScenario.amp }]
      })
      expect(exported.warnings).toEqual([])
    }).pipe(Effect.provide(layer)))

  it.effect("hidden blocks are notices; tools, plans, usage and turns come from the thread", () =>
    Effect.gen(function*() {
      const all = yield* events(ampScenario.amp)
      expect(all.filter((e) => e.type === "user.message")).toHaveLength(1)
      expect(all.filter((e) => e.type === "harness.notice")).toMatchObject([
        { kind: "injected_context", content: [{ type: "text", text: "The user has the following files open: README.md" }] }
      ])
      expect(all.filter((e) => e.type === "command.completed").map((e) => [e.outcome, e.exitCode, e.stdout]))
        .toEqual([["failed", 1, "1 failing: usage section missing example"], ["succeeded", 0, "2 passing"]])
      expect(all.find((e) => e.type === "plan.updated")).toMatchObject({
        entries: [
          { content: "Add a Usage section to README.md", status: "in_progress", priority: "high" },
          { content: "Make the tests pass", status: "pending", priority: "medium" }
        ]
      })
      expect(all.find((e) => e.type === "file.changed")).toMatchObject({ path: "/work/demo/README.md", diff: expect.stringMatching(/^@@ /) })
      // The Task subagent's transcript lives inside its result; only the call and its answer are events.
      expect(all.filter((e) => e.type === "tool.completed" && e.toolCallId === "toolu_task")).toMatchObject([{ output: "All links in docs/usage.md resolve." }])
      expect(all.some((e) => e.type === "file.read" && e.path.endsWith("docs/usage.md"))).toBe(false)
      const usage = all.filter((e) => e.type === "usage.recorded")
      expect(usage).toHaveLength(7)
      expect(usage[0]).toMatchObject({ model: "claude-opus-4-6", inputTokens: 3, cacheWriteTokens: 20, cacheReadTokens: 102, outputTokens: 40 })
      expect(all.filter((e) => e.type === "turn.completed")).toMatchObject([{ outcome: "completed", certainty: "known", durationMs: 12000 }])
      // Tool results carry no timestamps of their own and none are invented.
      expect(all.find((e) => e.type === "tool.completed")?.timestamp).toBeUndefined()
    }).pipe(Effect.provide(layer)))

  it.effect("exports: M- message IDs, ISO times and user shell commands", () =>
    Effect.gen(function*() {
      const all = yield* events(ampScenario.ampExported)
      expect(all.find((e) => e.type === "command.started")).toMatchObject({ command: "git status --short", cwd: "/work/demo", timestamp: "2026-09-01T10:00:21.000Z" })
      expect(all.find((e) => e.type === "command.completed")).toMatchObject({ outcome: "succeeded", exitCode: 0 })
      expect(all.find((e) => e.type === "tool.started")).toBeUndefined()
      // Non-Anthropic usage: uncached input is total minus cache reads; no cache writes.
      expect(all.find((e) => e.type === "usage.recorded")).toMatchObject({ model: "gpt-5.5", inputTokens: 50, cacheReadTokens: 200, outputTokens: 30 })
      expect(all.find((e) => e.type === "usage.recorded")).not.toHaveProperty("cacheWriteTokens")
    }).pipe(Effect.provide(layer)))

  it("classifies thread files and ignores in-flight rewrites", () => {
    const id = "T-dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    expect(classifyThreadFile([`${id}.json`], "/x")?.nativeId).toBe(id)
    expect(classifyThreadFile([`${id}.json.amptmp`], "/x")).toBeUndefined()
    expect(classifyThreadFile(["secrets.json"], "/x")).toBeUndefined()
    expect(classifyThreadFile(["sub", `${id}.json`], "/x")).toBeUndefined()
    expect(classifyExportFile(["anything.json"], "/x")).toEqual({ path: "/x", nativeId: undefined })
    expect(inspectHead(["{", "  \"v\": 1,", `  "id": "${id}",`, "  \"created\": 1788256800000,"]))
      .toEqual({ nativeId: id, startedAt: "2026-09-01T10:00:00.000Z" })
  })

  it("keeps later messages after malformed or orphaned ones", () => {
    const state = initialState(makeSessionId("amp", "T-x"), "test", undefined)
    const [next, first] = normalizeMessage(state, [{ role: "user", content: [{ type: "tool_result", toolUseID: "nope", run: { status: "done" } }] }, 0])
    expect(first.some((e) => e._tag === "Warning" && e.warning.code === "orphan_tool_result")).toBe(true)
    const [, malformed] = normalizeMessage(next, [{ role: "assistant", content: null }, 1])
    expect(malformed.map((e) => e._tag === "Warning" && e.warning.code)).toEqual(["malformed_record"])
    const [, unknown] = normalizeMessage(next, [{ role: "system", content: [] }, 2])
    expect(unknown.map((e) => e._tag === "Warning" && e.warning.code)).toEqual(["unknown_record_type"])
    const [, later] = normalizeMessage(next, [{ role: "user", content: [{ type: "text", text: "still here" }] }, 3])
    expect(later.some((e) => e._tag === "Event" && e.event.type === "user.message" && e.event.timestamp === undefined)).toBe(true)
  })

  it("cancelled assistant messages end the turn as interrupted and do not record partial usage", () => {
    let state = initialState(makeSessionId("amp", "T-x"), "test", undefined)
    ;[state] = normalizeMessage(state, [{ role: "user", messageId: 0, content: [{ type: "text", text: "go" }] }, 0])
    const [, cancelled] = normalizeMessage(state, [{
      role: "assistant",
      messageId: 1,
      content: [{ type: "text", text: "partial" }],
      state: { type: "cancelled" },
      usage: { model: "claude-x", inputTokens: 1, outputTokens: 2, totalInputTokens: 1 }
    }, 1])
    expect(cancelled.flatMap((e) => (e._tag === "Event" && e.event.type === "turn.completed" ? [e.event.outcome] : []))).toEqual(["interrupted"])
    const [, streaming] = normalizeMessage(state, [{
      role: "assistant",
      messageId: 1,
      content: [],
      state: { type: "streaming" },
      usage: { model: "claude-x", inputTokens: 1, outputTokens: 2, totalInputTokens: 1 }
    }, 1])
    expect(streaming.some((e) => e._tag === "Event" && e.event.type === "usage.recorded")).toBe(false)
  })

  it("maps shell runs, patches, usage, relationships and times", () => {
    expect(shellOutcome({ status: "done", result: { output: "x", exitCode: 2 } })).toEqual({ outcome: "failed", exitCode: 2, stdout: "x" })
    expect(shellOutcome({ status: "done", result: "no exit code" })).toEqual({ outcome: "unknown", stdout: "no exit code" })
    expect(shellOutcome({ status: "rejected-by-user" })).toEqual({ outcome: "interrupted" })
    expect(shellOutcome({ status: "error", error: { message: "boom" } })).toEqual({ outcome: "failed" })
    expect(patchOperations("*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Move to: c.ts\n@@\n*** Delete File: d.ts\n*** End Patch"))
      .toEqual([{ op: "add", path: "a.ts" }, { op: "update", path: "b.ts", movePath: "c.ts" }, { op: "delete", path: "d.ts" }])
    expect(ampUsage({ model: "gpt-5", inputTokens: 0, outputTokens: 0, totalInputTokens: 0 })).toBeUndefined()
    expect(ampUsage({ model: "gemini-3-pro", inputTokens: 0, outputTokens: 9, cacheCreationInputTokens: 70, cacheReadInputTokens: 30, totalInputTokens: 100 }))
      .toEqual({ model: "gemini-3-pro", inputTokens: 70, cacheReadTokens: 30, outputTokens: 9 })
    expect(pathFromUri("file:///work/my%20demo")).toBe("/work/my demo")
    expect(pathFromUri("https://example.com/x")).toBeUndefined()
    expect(instant(1788256800000)).toBe("2026-09-01T10:00:00.000Z")
    expect(instant("not a date")).toBeUndefined()
    const self = makeSessionId("amp", "T-a")
    expect(threadFacts({
      messages: [],
      originThreadID: "T-o",
      relationships: [
        { threadID: "T-p", type: "fork", role: "child" },
        { threadID: "T-c", type: "fork", role: "parent" },
        { threadID: "T-m", type: "mention", role: "parent" },
        { threadID: "T-z", type: "future", role: "child" },
        "garbage"
      ]
    }, self).patch.relationships).toEqual([
      { type: "fork", from: self, to: makeSessionId("amp", "T-o") },
      { type: "fork", from: self, to: makeSessionId("amp", "T-p") },
      { type: "fork", from: makeSessionId("amp", "T-c"), to: self },
      { type: "related", from: self, to: makeSessionId("amp", "T-m") }
    ])
  })
})
