import { Bridge, HostEnvironment } from "@agentbridge/core"
import { adapterContract, bridgeWithAdapter, checkEventInvariants, expectGolden, piFixtureAgentDir, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { activePath, bashStatus, PiAdapter } from "../src/index.ts"
import { classifyPiFile } from "../src/PiAdapter.ts"
import { idFromFileName } from "../src/PiNormalizer.ts"

const layer = bridgeWithAdapter(PiAdapter, PiAdapter.layer, HostEnvironment.layer({ PI_CODING_AGENT_DIR: piFixtureAgentDir }))

adapterContract({ harness: "pi", layer, expectedSessions: [scenario.pi, scenario.piSubagent, scenario.piBranched], damagedSession: scenario.pi })

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("pi", () => {
  it.effect("golden files", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.pi)))
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.piSubagent)))
    }).pipe(Effect.provide(layer)))

  it.effect("session metadata and spawned runs", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.pi)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:00.000Z",
        metadata: { model: "gpt-5.5" }
      })
      const child = yield* bridge.sessions.get(scenario.piSubagent)
      expect(child.session).toMatchObject({ parentSessionId: scenario.pi, agentLabel: "explorer" })
    }).pipe(Effect.provide(layer)))

  it("reads exit status from the bash trailer", () => {
    expect(bashStatus("boom\n\nCommand exited with code 2", true)).toEqual({ outcome: "failed", exitCode: 2 })
    expect(bashStatus("ok", false)).toEqual({ outcome: "succeeded" })
    expect(bashStatus("Command timed out after 30 seconds", true)).toEqual({ outcome: "interrupted" })
  })

  it("classifies transcripts and spawned runs, skipping other files", () => {
    expect(classifyPiFile(["--w--", "2026-01-01T00-00-00-000Z_abc.jsonl"], "/a")).toEqual({ path: "/a", nativeId: "abc" })
    expect(classifyPiFile(["--w--", "2026-01-01T00-00-00-000Z_abc", "agent01", "run-0", "session.jsonl"], "/b"))
      .toEqual({ path: "/b", parentNativeId: "abc", agentLabel: "agent01" })
    expect(classifyPiFile(["run-history.jsonl"], "/c")).toBeUndefined()
    expect(classifyPiFile(["--w--", "notes", "x.jsonl"], "/d")).toBeUndefined()
    // Custom session IDs may contain `_`; the timestamp never does.
    expect(classifyPiFile(["--w--", "2026-01-01T00-00-00-000Z_my_id.jsonl"], "/e")).toEqual({ path: "/e", nativeId: "my_id" })
    expect(classifyPiFile(["--w--", "2026-01-01T00-00-00-000Z_my_id", "agent01", "run-0", "session.jsonl"], "/f"))
      .toEqual({ path: "/f", parentNativeId: "my_id", agentLabel: "agent01" })
    // A custom session directory is flat.
    expect(classifyPiFile(["2026-01-01T00-00-00-000Z_abc.jsonl"], "/g", true)).toEqual({ path: "/g", nativeId: "abc" })
    expect(classifyPiFile(["2026-01-01T00-00-00-000Z_abc", "agent01", "run-0", "session.jsonl"], "/h", true))
      .toEqual({ path: "/h", parentNativeId: "abc", agentLabel: "agent01" })
  })

  it("reads session IDs from file names and paths", () => {
    expect(idFromFileName("/a/my_dir/2026-01-01T00-00-00-000Z_x_y.jsonl")).toBe("x_y")
    expect(idFromFileName("2026-01-01T00-00-00-000Z_0190d1e2-aaaa.jsonl")).toBe("0190d1e2-aaaa")
    expect(idFromFileName("session.jsonl")).toBeUndefined()
  })

  it.effect("pi 1.0 records: cache warm-up usage, context edits and unified edit patches", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.pi))
      const usage = events.filter((e) => e.type === "usage.recorded")
      expect(usage.at(-1)).toMatchObject({ model: "gpt-5.5", inputTokens: 0, cacheReadTokens: 46, outputTokens: 1 })
      const edit = events.find((e) => e.type === "file.changed" && e.path === "README.md")
      expect(edit).toMatchObject({ diff: expect.stringMatching(/^--- README\.md\n\+\+\+ README\.md\n@@/) })
      const { warnings } = yield* bridge.sessions.get(scenario.pi)
      expect(warnings.map((w) => w.code).sort()).toEqual(["malformed_json", "unknown_record_type"])
    }).pipe(Effect.provide(layer)))
})

describe("pi custom session directory (PI_CODING_AGENT_SESSION_DIR)", () => {
  const customLayer = bridgeWithAdapter(
    PiAdapter,
    PiAdapter.layer,
    HostEnvironment.layer({ PI_CODING_AGENT_DIR: piFixtureAgentDir, PI_CODING_AGENT_SESSION_DIR: `${piFixtureAgentDir}/custom-sessions` })
  )
  const custom = "pi:demo_custom-id.1"

  it.effect("lists flat sessions, keeping IDs that contain `_`", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const listed = yield* Stream.runCollect(bridge.sessions.list({ harness: "pi" }))
      expect(listed.map((d) => d.id).sort()).toEqual([custom, scenario.pi, scenario.piBranched, scenario.piSubagent].sort())
    }).pipe(Effect.provide(customLayer)))

  it.effect("user shell commands, legacy hook messages, PowerShell and deferred responses", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(custom))
      expect(checkEventInvariants(events)).toEqual([])
      expectGolden(golden("custom-dir"), events)
      const completed = events.filter((e) => e.type === "command.completed")
      expect(completed.map((e) => [e.outcome, e.exitCode])).toEqual([
        ["succeeded", 0],
        ["failed", 1],
        ["interrupted", undefined],
        ["succeeded", undefined]
      ])
      expect(events.find((e) => e.type === "tool.started")).toMatchObject({ name: "powershell", kind: "execute" })
      expect(events.some((e) => e.type === "harness.notice" && JSON.stringify(e.content).includes("linter"))).toBe(true)
      // The deferred placeholder neither ends the turn nor records usage; the final response does both.
      expect(events.filter((e) => e.type === "usage.recorded")).toHaveLength(2)
      expect(events.filter((e) => e.type === "turn.completed").map((e) => e.outcome)).toEqual(["completed"])
    }).pipe(Effect.provide(customLayer)))
})

describe("pi branches", () => {
  it("keeps only the path from the last entry to the root", () => {
    expect(activePath([["a", undefined], ["b", "a"], ["c", "b"]])).toBeUndefined()
    // c was abandoned: /tree went back to b and continued with d.
    expect([...activePath([["a", undefined], ["b", "a"], ["c", "b"], ["d", "b"], ["e", "d"]])!]).toEqual(["e", "d", "b", "a"])
  })

  it.effect("abandoned branches are not part of the event stream", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.piBranched))
      const text = events.flatMap((e) => (e.type === "user.message" ? [JSON.stringify(e.content)] : []))
      expect(text.some((t) => t.includes("abandoned"))).toBe(false)
      expect(text.some((t) => t.includes("kept"))).toBe(true)
    }).pipe(Effect.provide(layer)))
})
