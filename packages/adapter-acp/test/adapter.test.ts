import { Bridge, HostEnvironment } from "@agentbridge/core"
import { acpFixtureRecordings, adapterContract, bridgeWithAdapter, checkEventInvariants, expectGolden, scenario, semanticProjection } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Stream, HashMap, HashSet } from "effect"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { acpEvents, AcpRecordingAdapter } from "../src/index.ts"
import { initialState, normalizeEnvelope } from "../src/AcpNormalizer.ts"

const layer = bridgeWithAdapter(AcpRecordingAdapter, AcpRecordingAdapter.layer, HostEnvironment.layer({ BRIDGE_ACP_RECORDINGS: acpFixtureRecordings }))

adapterContract({ harness: "acp", layer, expectedSessions: [scenario.acp], damagedSession: scenario.acp })

const recording = readFileSync(`${acpFixtureRecordings}/claude-code-acp/sess_acp_1.jsonl`, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown]
    } catch {
      return []
    }
  })

const expectedSteps = [
  ["user", "Add a Usage section to README.md and make sure the tests pass."],
  ["read", "README.md"],
  ["changed", "README.md"],
  ["command", "npm test", "failed"],
  ["created", "docs/usage.md"],
  ["command", "npm test", "succeeded"],
  ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
]

const update = (value: unknown) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: value } })

describe("acp", () => {
  it.effect("preserves inline images and incremental tool fields", () =>
    Effect.gen(function*() {
      const events = yield* Stream.make(
        { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] } },
        update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Preparing", status: "pending" }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "t", kind: "execute", title: "Run tests", rawInput: { command: "npm test" } }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", rawOutput: { exitCode: 0 } }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" })
      ).pipe(acpEvents({ agent: "a", sessionId: "s" }), Stream.runCollect)
      expect(events.find((e) => e.type === "user.message")).toMatchObject({ content: [{ type: "image", uri: "data:image/png;base64,aGVsbG8=" }] })
      expect(events.find((e) => e.type === "tool.updated")).toMatchObject({ name: "Run tests", kind: "execute", input: { command: "npm test" } })
      expect(events.find((e) => e.type === "command.started")).toMatchObject({ command: "npm test" })
      expect(events.filter((e) => e.type === "command.completed")).toHaveLength(1)
      expect(checkEventInvariants(events)).toEqual([])
    }))

  it("does not retain finished tool payloads or mutate previous states", () => {
    const original = initialState({ agent: "a", sessionId: "s", source: "test" })
    let state = original
    for (let i = 0; i < 1000; i++) {
      ;[state] = normalizeEnvelope(state, { index: i, message: update({ sessionUpdate: "tool_call", toolCallId: String(i), title: "Read", kind: "read", status: "completed", rawOutput: "large payload" }) })
    }
    expect(HashMap.size(state.tools)).toBe(0)
    expect(HashSet.size(state.finishedTools)).toBe(1000)
    expect(HashSet.size(original.finishedTools)).toBe(0)
  })

  it.effect("golden file", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(
        fileURLToPath(new URL("./golden/scenario.jsonl", import.meta.url)),
        yield* Stream.runCollect(bridge.sessions.events(scenario.acp))
      )
    }).pipe(Effect.provide(layer)))

  it.effect("recorded ACP traffic yields the reference primitives and metadata", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.acp)
      expect(session).toMatchObject({ title: "Add README usage section", projectPath: "/work/demo" })
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.acp))
      expect(semanticProjection(session, events)).toEqual(expectedSteps)
      // Streamed chunks become one message each.
      expect(events.filter((e) => e.type === "agent.reasoning").map((e) => e.content)).toEqual(["I should read the README first."])
      expect(events.find((e) => e.type === "plan.updated")).toMatchObject({
        entries: [{ content: "Read README.md", status: "in_progress", priority: "high" }, {}, {}]
      })
    }).pipe(Effect.provide(layer)))

  it.effect("a live connection converges on the same events as the recording", () =>
    Effect.gen(function*() {
      const queue = yield* Queue.unbounded<unknown>()
      const collector = yield* Effect.forkChild(
        Stream.fromQueue(queue).pipe(
          Stream.takeUntil((item) => JSON.stringify(item).includes("usage_update")),
          acpEvents({ agent: "claude-code-acp", sessionId: "sess_acp_1" }),
          Stream.runCollect
        )
      )
      // Interleave another session's traffic, as a multiplexed connection would.
      for (const message of recording) {
        yield* Queue.offer(queue, message)
        yield* Queue.offer(queue, { jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "noise" } } } })
      }
      const live = yield* Fiber.join(collector)
      expect(checkEventInvariants(live)).toEqual([])
      expect(semanticProjection({ projectPath: "/work/demo" }, live)).toEqual(expectedSteps)
      expect(live.some((e) => JSON.stringify(e).includes("noise"))).toBe(false)
    }))

  it.effect("cancelled turns become interruption notices; in-flight chunks flush at stream end", () =>
    Effect.gen(function*() {
      const events = yield* Stream.make(
        { jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "go" }] } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part" } } } },
        { jsonrpc: "2.0", id: 7, result: { stopReason: "cancelled" } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tail" } } } }
      ).pipe(acpEvents({ agent: "a", sessionId: "s" }), Stream.runCollect)
      expect(events.map((e) => e.type)).toEqual([
        "session.started",
        "turn.started",
        "user.message",
        "agent.message",
        "harness.notice",
        "turn.completed",
        "agent.message"
      ])
      expect(events[4]).toMatchObject({ kind: "interruption" })
      expect(events[5]).toMatchObject({ turnId: "7", outcome: "interrupted" })
    }))
})
