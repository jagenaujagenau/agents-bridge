import { Bridge, HostEnvironment } from "@agentbridge/core"
import { adapterContract, antigravityFixtureHome, bridgeWithAdapter, expectGolden, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { AntigravityAdapter, splitUserInput } from "../src/index.ts"
import { classifyAntigravityFile } from "../src/AntigravityAdapter.ts"

const layer = bridgeWithAdapter(AntigravityAdapter, AntigravityAdapter.layer, HostEnvironment.layer({ ANTIGRAVITY_HOME: antigravityFixtureHome }))

adapterContract({ harness: "antigravity", layer, expectedSessions: [scenario.antigravity], damagedSession: scenario.antigravity })

describe("antigravity", () => {
  it.effect("golden file", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(
        fileURLToPath(new URL("./golden/scenario.jsonl", import.meta.url)),
        yield* Stream.runCollect(bridge.sessions.events(scenario.antigravity))
      )
    }).pipe(Effect.provide(layer)))

  it.effect("prefers the full transcript and skips replayed history", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const descriptor = yield* bridge.sessions.describe(scenario.antigravity)
      expect(descriptor.sourcePath.endsWith("transcript_full.jsonl")).toBe(true)
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.antigravity))
      expect(events.some((e) => e.type === "agent.message" && JSON.stringify(e.content).includes("earlier replayed"))).toBe(false)
      const { session } = yield* bridge.sessions.get(scenario.antigravity)
      expect(session).toMatchObject({ projectPath: "/work/demo", startedAt: "2026-09-01T10:00:00.000Z" })
    }).pipe(Effect.provide(layer)))

  it.effect("tool outputs pair with calls by order, so completions are inferred", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.antigravity))
      const completions = events.filter((e) => e.type === "tool.completed")
      expect(completions.every((e) => e.certainty === "inferred")).toBe(true)
      expect(events.filter((e) => e.type === "command.completed").map((e) => [e.outcome, e.exitCode])).toEqual([["failed", 1], ["succeeded", 0]])
    }).pipe(Effect.provide(layer)))

  it("splits the user request from harness context", () => {
    expect(splitUserInput("<USER_REQUEST>\nhi\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"))
      .toEqual({ prompt: "hi", context: "<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>" })
    expect(classifyAntigravityFile(["c", ".system_generated", "logs", "transcript.jsonl"], "/a")?.nativeId).toBe("c")
    expect(classifyAntigravityFile(["c", "task.md"], "/a")).toBeUndefined()
  })
})
