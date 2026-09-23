import { Bridge, HostEnvironment, sequenceEvents } from "@agentbridge/core"
import { makeSessionId } from "@agentbridge/schema"
import { adapterContract, bridgeWithAdapter, checkEventInvariants, claudeFixtureDir, expectGolden, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { ClaudeCodeAdapter, classifyProjectFile, classifyUserText } from "../src/index.ts"
import { initialState, normalizeLine, onHalt } from "../src/ClaudeCodeNormalizer.ts"
import { decodeLine } from "../src/ClaudeCodeSource.ts"

const layer = bridgeWithAdapter(
  ClaudeCodeAdapter,
  ClaudeCodeAdapter.layer,
  HostEnvironment.layer({ CLAUDE_CONFIG_DIR: claudeFixtureDir })
)

adapterContract({
  harness: "claude-code",
  layer,
  expectedSessions: [scenario.claude, scenario.claudeSubagent],
  damagedSession: scenario.claude
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("claude-code golden files", () => {
  it.effect("scenario session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.claude)))
    }).pipe(Effect.provide(layer)))

  it.effect("subagent session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.claudeSubagent)))
    }).pipe(Effect.provide(layer)))
})

describe("claude-code normalization", () => {
  it.effect("session metadata", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.claude)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        harness: { id: "claude-code", name: "Claude Code", version: "2.1.50" },
        startedAt: "2026-09-01T10:00:00.000Z",
        metadata: { model: "claude-opus-5", gitBranch: "main" },
        relationships: [{
          type: "resume",
          from: "claude-code:44444444-4444-4444-8444-444444444444",
          to: scenario.claude
        }]
      })
      const sub = yield* bridge.sessions.get(scenario.claudeSubagent)
      expect(sub.session).toMatchObject({
        parentSessionId: scenario.claude,
        agentLabel: "Explore",
        title: "Find TODO comments"
      })
    }).pipe(Effect.provide(layer)))

  it.effect("tool results become completions, never user messages", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.claude))
      expect(events.filter((e) => e.type === "user.message")).toHaveLength(1)
      const failed = events.find((e) => e.type === "command.completed" && e.outcome === "failed")
      expect(failed).toMatchObject({ exitCode: 1 })
      const passed = events.find((e) => e.type === "command.completed" && e.outcome === "succeeded")
      expect(passed).not.toHaveProperty("exitCode")
      expect(events.find((e) => e.type === "harness.notice")).toMatchObject({ kind: "injected_context" })
    }).pipe(Effect.provide(layer)))

  it("classifies injected text and slash commands", () => {
    expect(classifyUserText("<local-command-stdout>ok</local-command-stdout>", false)).toEqual({
      _tag: "Notice",
      kind: "command_output"
    })
    expect(classifyUserText("hello", true)).toEqual({ _tag: "Notice", kind: "injected_context" })
    expect(
      classifyUserText("<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>ship it</command-args>", false)
    ).toEqual({ _tag: "Prompt", text: "/goal ship it" })
    expect(classifyUserText("<bash-input>git status</bash-input>", false)).toEqual({ _tag: "Prompt", text: "!git status" })
    expect(classifyUserText("[Request interrupted by user]", false)).toEqual({ _tag: "Notice", kind: "interruption" })
  })

  it("discovers both subagent layouts and skips non-sessions", () => {
    const uuid = "11111111-1111-4111-8111-111111111111"
    expect(classifyProjectFile(["p", `${uuid}.jsonl`], "/x")?.nativeId).toBe(uuid)
    expect(classifyProjectFile(["p", uuid, "subagents", "workflows", "wf_1", "agent-z.jsonl"], "/x")?.nativeId)
      .toBe(`${uuid}/workflows/wf_1/agent-z`)
    expect(classifyProjectFile(["p", uuid, "subagents", "workflows", "wf_1", "journal.jsonl"], "/x")).toBeUndefined()
    expect(classifyProjectFile(["p", "memory", "x.jsonl"], "/x")).toBeUndefined()
    const flat = classifyProjectFile(["p", "agent-q.jsonl"], "/x")
    expect(flat?.nativeId).toBeUndefined()
    expect(flat?.agentFile).toBe("agent-q")
  })
})

describe("claude-code turns, usage and user shell", () => {
  const normalize = (records: ReadonlyArray<object>) => {
    const sessionId = makeSessionId("claude-code", "t")
    return Effect.runSync(
      Stream.fromIterable(records.map((r, index) => ({ index, line: JSON.stringify(r) }))).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/t.jsonl"), normalizeLine, { onHalt }),
        sequenceEvents(sessionId),
        Stream.runCollect
      )
    )
  }
  const at = (s: number) => `2026-09-01T10:00:0${s}.000Z`
  const user = (uuid: string, content: string, extra: object = {}) => ({ type: "user", uuid, timestamp: at(0), message: { role: "user", content }, ...extra })
  const assistant = (uuid: string, messageId: string, text: string, usage: object) =>
    ({ type: "assistant", uuid, timestamp: at(1), message: { id: messageId, model: "m", content: [{ type: "text", text }], usage } })

  it("emits one usage event per API message, with the final counts", () => {
    const events = normalize([
      user("u1", "hi", { promptId: "p1" }),
      assistant("a1", "msg_1", "one", { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100 }),
      assistant("a2", "msg_1", "two", { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 100 }),
      assistant("a3", "msg_2", "three", { input_tokens: 1, output_tokens: 2 })
    ])
    expect(events.filter((e) => e.type === "usage.recorded")).toMatchObject([
      { inputTokens: 3, outputTokens: 9, cacheReadTokens: 100, model: "m" },
      { inputTokens: 1, outputTokens: 2 }
    ])
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("prompts start turns; turn_duration and interruptions end them", () => {
    const events = normalize([
      user("u1", "first", { promptId: "p1" }),
      { type: "system", uuid: "s1", subtype: "turn_duration", durationMs: 1200, timestamp: at(2) },
      user("u2", "second", { promptId: "p2" }),
      user("u3", "[Request interrupted by user]"),
      user("u4", "third", { promptId: "p3" })
    ])
    expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => [e.type, (e as { turnId: string }).turnId, (e as { outcome?: string }).outcome, e.certainty]))
      .toEqual([
        ["turn.started", "p1", undefined, "known"],
        ["turn.completed", "p1", "completed", "known"],
        ["turn.started", "p2", undefined, "known"],
        ["turn.completed", "p2", "interrupted", "inferred"],
        ["turn.started", "p3", undefined, "known"]
      ])
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("`!cmd` becomes a command, not a prompt", () => {
    const events = normalize([
      user("u1", "<bash-input>git status</bash-input>"),
      user("u2", "<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>")
    ])
    expect(events.map((e) => e.type)).toEqual(["session.started", "command.started", "command.completed"])
    expect(events[2]).toMatchObject({ outcome: "unknown", stdout: "clean" })
  })
})
