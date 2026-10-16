import { Bridge, HostEnvironment } from "@agentbridge/core"
import { adapterContract, bridgeWithAdapter, expectGolden, fixturesDir, semanticProjection } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { activePath, QwenCodeAdapter, shellStatus, usageOf } from "../src/index.ts"
import { classifyQwenFile } from "../src/QwenCodeAdapter.ts"

/** Scenario session IDs (the integrator mirrors these in packages/testing/src/fixtures.ts). */
export const qwenScenario = {
  qwen: "qwen-code:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  qwenSubagent: "qwen-code:dddddddd-dddd-4ddd-8ddd-dddddddddddd/agent-explore-7f3c",
  qwenBranched: "qwen-code:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
} as const

const qwenFixtureHome = `${fixturesDir}qwen-code`

const layer = bridgeWithAdapter(QwenCodeAdapter, QwenCodeAdapter.layer, HostEnvironment.layer({ QWEN_HOME: qwenFixtureHome }))

adapterContract({
  harness: "qwen-code",
  layer,
  expectedSessions: Object.values(qwenScenario),
  damagedSession: qwenScenario.qwen
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

const events = (id: string) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    return yield* Stream.runCollect(bridge.sessions.events(id))
  })

describe("qwen-code", () => {
  it.effect("golden files", () =>
    Effect.gen(function*() {
      expectGolden(golden("scenario"), yield* events(qwenScenario.qwen))
      expectGolden(golden("subagent"), yield* events(qwenScenario.qwenSubagent))
    }).pipe(Effect.provide(layer)))

  it.effect("produces the reference scenario", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(qwenScenario.qwen)
      expect(semanticProjection(session, yield* events(qwenScenario.qwen))).toEqual([
        ["user", "Add a Usage section to README.md and make sure the tests pass."],
        ["read", "README.md"],
        ["changed", "README.md"],
        ["command", "npm test", "failed"],
        ["created", "docs/usage.md"],
        ["command", "npm test", "succeeded"],
        ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
      ])
    }).pipe(Effect.provide(layer)))

  it.effect("session metadata", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(qwenScenario.qwen)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:00.000Z",
        metadata: { model: "qwen3-coder-plus", gitBranch: "main" }
      })
      expect(session.harness).toMatchObject({ id: "qwen-code", name: "Qwen Code", version: "0.25.2" })
    }).pipe(Effect.provide(layer)))

  it.effect("hook context is a notice, exit codes and usage come from the record", () =>
    Effect.gen(function*() {
      const all = yield* events(qwenScenario.qwen)
      expect(all.filter((e) => e.type === "user.message")).toHaveLength(1)
      expect(all.filter((e) => e.type === "harness.notice").map((e) => [e.kind, e.content])).toEqual([
        ["injected_context", [{ type: "text", text: "<qwen:user-prompt-submit-context>\nProject uses vitest.\n</qwen:user-prompt-submit-context>" }]]
      ])
      expect(all.filter((e) => e.type === "command.completed").map((e) => [e.outcome, e.exitCode, e.stdout]))
        .toEqual([["failed", 1, "1 failing: usage section missing example"], ["succeeded", 0, "2 passing"]])
      expect(all.find((e) => e.type === "usage.recorded")).toMatchObject({
        model: "qwen3-coder-plus",
        inputTokens: 20,
        cacheReadTokens: 100,
        outputTokens: 13,
        reasoningTokens: 5
      })
      expect(all.find((e) => e.type === "agent.reasoning")).toMatchObject({ representation: "provider_exposed" })
      expect(all.filter((e) => e.type === "turn.completed").map((e) => [e.outcome, e.certainty])).toEqual([["completed", "inferred"]])
    }).pipe(Effect.provide(layer)))

  it.effect("subagent transcripts are linked children with their own ID", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(qwenScenario.qwenSubagent)
      expect(session).toMatchObject({ parentSessionId: qwenScenario.qwen, agentLabel: "Explore", projectPath: "/work/demo" })
      const all = yield* events(qwenScenario.qwenSubagent)
      expect(semanticProjection(session, all)).toEqual([
        ["user", "Find all TODO comments in src/."],
        ["agent", "There are no TODO comments in src/."]
      ])
      expect(all.find((e) => e.type === "tool.started")).toMatchObject({ name: "grep_search", kind: "search" })
      expect(all.some((e) => e.type === "tool.completed")).toBe(true)
    }).pipe(Effect.provide(layer)))

  it.effect("archived sessions load, and branches abandoned by /rewind are dropped", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session, warnings } = yield* bridge.sessions.get(qwenScenario.qwenBranched)
      expect(warnings).toEqual([])
      expect(session.title).toBe("Branch demo")
      const text = (yield* events(qwenScenario.qwenBranched)).flatMap((e) =>
        e.type === "user.message" || e.type === "agent.message" ? [JSON.stringify(e.content)] : []
      )
      expect(text.some((t) => t.includes("abandoned"))).toBe(false)
      expect(text.filter((t) => t.includes("kept"))).toHaveLength(4)
    }).pipe(Effect.provide(layer)))
})

describe("qwen-code helpers", () => {
  it("classifies sessions, archives and subagents, skipping sidecars", () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    expect(classifyQwenFile(["-w", "chats", `${id}.jsonl`], "/a")).toEqual({ path: "/a", nativeId: id })
    expect(classifyQwenFile(["-w", "chats", "archive", `${id}.jsonl`], "/b")).toEqual({ path: "/b", nativeId: id })
    expect(classifyQwenFile(["-w", "subagents", id, "agent-x1.jsonl"], "/c"))
      .toEqual({ path: "/c", nativeId: `${id}/agent-x1`, parentNativeId: id })
    for (const skipped of [`${id}.ledger.jsonl`, `${id}.runtime.json`, "notes.jsonl"]) {
      expect(classifyQwenFile(["-w", "chats", skipped], "/d")).toBeUndefined()
    }
    expect(classifyQwenFile(["-w", "subagents", id, "agent-x1.meta.json"], "/e")).toBeUndefined()
    expect(classifyQwenFile(["-w", "subagents", id, "agent-x1.jsonl.stream"], "/f")).toBeUndefined()
  })

  it("keeps the path from the last conversation record, ignoring side records", () => {
    const e = (uuid: string, parentUuid?: string, side = false) => ({ uuid, parentUuid, side })
    expect(activePath([e("a"), e("b", "a"), e("t", "b", true)])).toBeUndefined()
    expect([...activePath([e("a"), e("b", "a"), e("c", "b"), e("t", "c", true), e("d", "a"), e("x", "d", true)])!]).toEqual(["d", "a"])
  })

  it("reads shell status from the display, then from the model-facing text", () => {
    expect(shellStatus({ type: "shell_result", exitCode: 2, output: "boom", outcome: "failed" }, undefined, "error"))
      .toEqual({ outcome: "failed", exitCode: 2, stdout: "boom" })
    expect(shellStatus({ type: "shell_result", exitCode: null, output: "", outcome: "timed_out" }, undefined, "error"))
      .toEqual({ outcome: "interrupted", stdout: "" })
    expect(shellStatus(undefined, "Command: x\nDirectory: (root)\nOutput: hi\nError: (none)\nExit Code: 0\nSignal: (none)", "success"))
      .toEqual({ outcome: "succeeded", exitCode: 0, stdout: "hi" })
    expect(shellStatus(undefined, "[Operation Cancelled] Reason: user", "cancelled").outcome).toBe("interrupted")
    expect(shellStatus(undefined, undefined, "success")).toEqual({ outcome: "unknown" })
  })

  it("converts usage to canonical semantics for every provider shape", () => {
    // OpenAI-compatible: completion includes reasoning; total = prompt + completion.
    expect(usageOf({ promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 130 }, "m"))
      .toEqual({ model: "m", inputTokens: 40, cacheReadTokens: 60, outputTokens: 30, reasoningTokens: 10 })
    // Gemini: candidates exclude thoughts; total = prompt + candidates + thoughts.
    expect(usageOf({ promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 130 }, undefined))
      .toEqual({ inputTokens: 100, outputTokens: 30, reasoningTokens: 10 })
    // No usable total: the OpenAI converter's completion count.
    expect(usageOf({ promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 0 }, undefined))
      .toEqual({ inputTokens: 100, outputTokens: 20 })
  })
})
