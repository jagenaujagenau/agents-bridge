import { Bridge, HostEnvironment } from "@agentbridge/core"
import { adapterContract, bridgeWithAdapter, expectGolden, geminiFixtureHome, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { GeminiCliAdapter, shellStatus } from "../src/index.ts"
import { classifyGeminiFile, startFromNativeId } from "../src/GeminiCliAdapter.ts"
import { initialState, normalizeMessage } from "../src/GeminiNormalizer.ts"
import { makeSessionId } from "@agentbridge/schema"

const layer = bridgeWithAdapter(GeminiCliAdapter, GeminiCliAdapter.layer, HostEnvironment.layer({ GEMINI_CLI_HOME: geminiFixtureHome }))

adapterContract({
  harness: "gemini-cli",
  layer,
  expectedSessions: [scenario.gemini],
  damagedSession: scenario.gemini,
  damagedWarnings: ["malformed_record", "unknown_record_type"]
})

describe("gemini-cli", () => {
  it.effect("golden file", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(
        fileURLToPath(new URL("./golden/scenario.jsonl", import.meta.url)),
        yield* Stream.runCollect(bridge.sessions.events(scenario.gemini))
      )
    }).pipe(Effect.provide(layer)))

  it.effect("resolves the project from the hashed directory and reads chat metadata", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.gemini)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:14.000Z",
        metadata: { model: "gemini-3-pro" }
      })
    }).pipe(Effect.provide(layer)))

  it.effect("referenced-file blocks and function-response echoes are not prompts", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.gemini))
      const prompts = events.filter((e) => e.type === "user.message")
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ content: [{ type: "text", text: "Add a Usage section to README.md and make sure the tests pass." }] })
      expect(events.filter((e) => e.type === "command.completed").map((e) => [e.outcome, e.exitCode, e.stdout]))
        .toEqual([["failed", 1, "1 failing: usage section missing example"], ["succeeded", 0, "2 passing"]])
    }).pipe(Effect.provide(layer)))

  it("warns on malformed nested results without losing later messages", () => {
    const [state, emissions] = normalizeMessage(initialState(makeSessionId("gemini-cli", "s"), "test", undefined), [{ type: "gemini", toolCalls: [{ id: "t", name: "read_file", status: "success", result: [{ functionResponse: null }] }] }, 0])
    expect(emissions.some((e) => e._tag === "Warning" && e.warning.code === "malformed_record")).toBe(true)
    const [, next] = normalizeMessage(state, [{ type: "user", content: "still here" }, 1])
    expect(next.some((e) => e._tag === "Event" && e.event.type === "user.message")).toBe(true)
  })

  it("does not interpret UUID prefixes as seconds", () => {
    expect(startFromNativeId("2026-02-23T04-07-12345678-abcd")).toBe("2026-02-23T04:07:00Z")
    expect(startFromNativeId("2026-02-23T04-07-99999999-abcd")).toBe("2026-02-23T04:07:00Z")
    expect(startFromNativeId("2026-02-23T04-07-30-12345678")).toBe("2026-02-23T04:07:30Z")
    expect(startFromNativeId("2026-02-30T04-07-deadbeef")).toBeUndefined()
  })

  it("parses shell status and file names", () => {
    expect(shellStatus("Output: x\nError: (none)\nExit Code: 3\nSignal: (none)", "success")).toEqual({ outcome: "failed", exitCode: 3 })
    expect(shellStatus(undefined, "cancelled")).toEqual({ outcome: "interrupted" })
    expect(classifyGeminiFile(["abc", "chats", "session-2026-01-02T03-04-deadbeef.json"], "/x")?.nativeId).toBe("2026-01-02T03-04-deadbeef")
    expect(classifyGeminiFile(["abc", "logs.json"], "/x")).toBeUndefined()
    expect(startFromNativeId("2026-01-02T03-04-deadbeef")).toBe("2026-01-02T03:04:00Z")
  })
})
