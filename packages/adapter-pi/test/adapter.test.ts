import { Bridge, HostEnvironment } from "@agentbridge/core"
import { adapterContract, bridgeWithAdapter, expectGolden, piFixtureAgentDir, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { activePath, bashStatus, PiAdapter } from "../src/index.ts"
import { classifyPiFile } from "../src/PiAdapter.ts"

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
  })
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
