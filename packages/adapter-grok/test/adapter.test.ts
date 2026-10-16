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
import { Effect, FileSystem, Layer, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { decodeLine, initialState, normalizeLine, onHalt } from "../src/GrokNormalizer.ts"
import {
  classifyGrokFile,
  decodeCwdDir,
  exitCodeOf,
  GrokAdapter,
  grokToolKind,
  noticeKindOf,
  summaryMetadata,
  unwrapUserQuery
} from "../src/index.ts"
import { GROK_SESSION, GROK_SUBAGENT } from "./generate-fixture.ts"

/** The §63 scenario recorded by Grok Build (see generate-fixture.ts). */
export const grokScenario = {
  grok: `grok:${GROK_SESSION}`,
  grokSubagent: `grok:${GROK_SUBAGENT}`
} as const

/** GROK_HOME replaces ~/.grok. */
const grokFixtureHome = `${fixturesDir}grok`

const layer = bridgeWithAdapter(GrokAdapter, GrokAdapter.layer, HostEnvironment.layer({ GROK_HOME: grokFixtureHome }))

adapterContract({
  harness: "grok",
  layer,
  expectedSessions: Object.values(grokScenario),
  damagedSession: grokScenario.grok
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

const view = (id: string) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const { session, warnings } = yield* bridge.sessions.get(id)
    const events = yield* Stream.runCollect(bridge.sessions.events(id))
    return { session, warnings, events }
  })

describe("grok golden files", () => {
  it.effect("scenario and subagent sessions", () =>
    Effect.gen(function*() {
      expectGolden(golden("scenario"), (yield* view(grokScenario.grok)).events)
      expectGolden(golden("subagent"), (yield* view(grokScenario.grokSubagent)).events)
    }).pipe(Effect.provide(layer)))
})

describe("grok normalization", () => {
  it.effect("session metadata comes from summary.json", () =>
    Effect.gen(function*() {
      const { session, warnings } = yield* view(grokScenario.grok)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        harness: { id: "grok", name: "Grok Build" },
        startedAt: "2026-09-01T10:00:01.000Z",
        status: "unknown",
        metadata: { model: "grok-4.6", gitBranch: "main" }
      })
      expect(session.capabilities.tokenUsage).toBe(false)
      expect(warnings.map((w) => w.code).sort()).toEqual(["malformed_json", "unknown_record_type"])
    }).pipe(Effect.provide(layer)))

  it.effect("produces the reference scenario", () =>
    Effect.gen(function*() {
      const { events, session } = yield* view(grokScenario.grok)
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
      expect(events.filter((e) => e.type === "harness.notice")).toMatchObject([{ kind: "injected_context" }])
      expect(events.filter((e) => e.type === "command.completed"))
        .toMatchObject([{ outcome: "failed", exitCode: 1 }, { outcome: "succeeded", exitCode: 0 }])
      expect(events.filter((e) => e.type === "tool.started").map((e) => [e.name, e.kind])).toEqual([
        ["read_file", "read"],
        ["search_replace", "edit"],
        ["run_terminal_command", "execute"],
        ["write", "edit"],
        ["run_terminal_command", "execute"],
        ["spawn_subagent", "other"]
      ])
      expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => [e.type, e.certainty]))
        .toEqual([["turn.started", "known"], ["turn.completed", "known"]])
      expect(events.find((e) => e.type === "agent.reasoning")).toMatchObject({ content: "I should read the README first." })
      // Per-run totals are not per-call usage.
      expect(events.some((e) => e.type === "usage.recorded")).toBe(false)
      expect(checkEventInvariants(events)).toEqual([])
    }).pipe(Effect.provide(layer)))

  it.effect("token totals per run are session metadata", () =>
    Effect.gen(function*() {
      const { session } = yield* view(grokScenario.grok)
      expect(session.metadata["tokenTotals"]).toEqual({
        inputTokens: 4200,
        outputTokens: 310,
        totalTokens: 4510,
        cachedReadTokens: 2800,
        cacheCreationTokens: 0,
        reasoningTokens: 90,
        modelCalls: 6
      })
    }).pipe(Effect.provide(layer)))

  it.effect("a subagent session is linked to its parent by summary.json", () =>
    Effect.gen(function*() {
      const { events, session } = yield* view(grokScenario.grokSubagent)
      expect(session).toMatchObject({ parentSessionId: grokScenario.grok, title: "Find TODO comments", projectPath: "/work/demo" })
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Find all TODO comments in src/."],
        ["agent", "There are no TODO comments in src/."]
      ])
      const bridge = yield* Bridge
      const listed = yield* Stream.runCollect(bridge.sessions.list())
      expect(listed.find((d) => d.id === grokScenario.grokSubagent)).toMatchObject({ parentSessionId: grokScenario.grok, agentLabel: "explore" })
    }).pipe(Effect.provide(layer)))
})

describe("grok never reads credentials or the model-facing copy", () => {
  const touched: Array<string> = []
  const spiedFs = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(Effect.service(FileSystem.FileSystem), (fs) =>
      new Proxy(fs, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver)
          return typeof value === "function"
            ? (...args: Array<unknown>) => {
              if (typeof args[0] === "string") touched.push(args[0])
              return value.apply(target, args)
            }
            : value
        }
      }))
  )
  const spied = bridgeWithAdapter(
    GrokAdapter,
    GrokAdapter.layer.pipe(Layer.provide(spiedFs)),
    HostEnvironment.layer({ GROK_HOME: grokFixtureHome })
  )

  it.effect("auth.json and chat_history.jsonl are never opened", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.harnesses.detect
      for (const descriptor of yield* Stream.runCollect(bridge.sessions.list())) {
        yield* Stream.runDrain(bridge.sessions.events(descriptor.id))
      }
      expect(touched.some((p) => p.endsWith("updates.jsonl"))).toBe(true)
      expect(touched.some((p) => p.endsWith("summary.json"))).toBe(true)
      expect(touched.filter((p) => p.endsWith("auth.json") || p.endsWith("chat_history.jsonl"))).toEqual([])
    }).pipe(Effect.provide(spied)))
})

describe("grok discovery", () => {
  it("classifies session logs only", () => {
    const id = "01990a00-0000-7000-8000-00000000a001"
    expect(classifyGrokFile(["%2Fwork%2Fdemo", id, "updates.jsonl"], "/x")?.nativeId).toBe(id)
    expect(classifyGrokFile(["%2Fwork%2Fdemo", id, "chat_history.jsonl"], "/x")).toBeUndefined()
    expect(classifyGrokFile(["%2Fwork%2Fdemo", id, "summary.json"], "/x")).toBeUndefined()
    expect(classifyGrokFile(["%2Fwork%2Fdemo", id, "subagents", "x", "updates.jsonl"], "/x")).toBeUndefined()
    expect(classifyGrokFile(["%2Fwork%2Fdemo", "../etc", "updates.jsonl"], "/x")).toBeUndefined()
    expect(classifyGrokFile(["auth.json"], "/x")).toBeUndefined()
  })

  it("decodes the working directory from the group directory", () => {
    expect(decodeCwdDir("%2Fwork%2Fdemo")).toBe("/work/demo")
    expect(decodeCwdDir("C%3A%5Cwork")).toBe("C:\\work")
    expect(decodeCwdDir("work-demo-3f9a2c")).toBeUndefined()
    expect(decodeCwdDir("%E0%A4%A")).toBeUndefined()
  })
})

describe("grok records beyond the scenario", () => {
  const sessionId = makeSessionId("grok", "t")
  let at = 0
  const line = (update: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({
    timestamp: 1788256800 + at++,
    params: { sessionId: "t", update, _meta: meta }
  })
  const normalize = (records: ReadonlyArray<object>) =>
    Effect.runSync(
      Stream.fromIterable(records.map((r, index) => ({ index, line: JSON.stringify(r) }))).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/t/updates.jsonl"), normalizeLine, { onHalt }),
        sequenceEvents(sessionId),
        Stream.runCollect
      )
    )

  it("tools recorded without a kind take it from the native name or a later update", () => {
    const events = normalize([
      line({ sessionUpdate: "user_message_chunk", content: { text: "inspect" } }, { promptIndex: 0 }),
      // A client's echo of the same prompt chunk is one fact.
      line({ sessionUpdate: "user_message_chunk", content: { text: "inspect" } }, { promptIndex: 0 }),
      line({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read_file", rawInput: { path: "/w/a.txt" } }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "c1", kind: "read", status: "completed", rawOutput: "contents" }),
      line({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Shell", toolName: "run_terminal_cmd", rawInput: { command: "sleep 9" } }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "cancelled", rawOutput: "interrupted" }),
      line({ sessionUpdate: "turn_completed", prompt_id: "p", stop_reason: "cancelled" })
    ])
    expect(events.filter((e) => e.type === "user.message")).toHaveLength(1)
    expect(events.filter((e) => e.type === "tool.started").map((e) => [e.name, e.kind])).toEqual([["read_file", "read"], ["run_terminal_cmd", "execute"]])
    expect(events.find((e) => e.type === "file.read")).toMatchObject({ path: "/w/a.txt" })
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ output: "contents" })
    expect(events.find((e) => e.type === "command.completed")).toMatchObject({ outcome: "interrupted" })
    expect(events.find((e) => e.type === "command.completed")).not.toHaveProperty("exitCode")
    expect(events.find((e) => e.type === "turn.completed")).toMatchObject({ outcome: "interrupted", turnId: "prompt-0" })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("edits without diffs fall back to the input; failed edits have no effects", () => {
    const events = normalize([
      line({ sessionUpdate: "tool_call", toolCallId: "w", kind: "edit", rawInput: { file_path: "/w/new.md", content: "x" }, _meta: { "x.ai/tool": { name: "write" } } }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "w", status: "completed" }),
      line({ sessionUpdate: "tool_call", toolCallId: "e", kind: "edit", rawInput: { file_path: "/w/a.md", old_string: "a", new_string: "b" }, _meta: { "x.ai/tool": { name: "search_replace" } } }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed" }),
      line({ sessionUpdate: "tool_call", toolCallId: "f", kind: "edit", rawInput: { file_path: "/w/b.md", old_string: "zz", new_string: "b" }, _meta: { "x.ai/tool": { name: "search_replace" } } }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "f", status: "failed", content: [{ type: "content", content: { type: "text", text: "No matches found" } }] })
    ])
    expect(events.filter((e) => e.type.startsWith("file.")).map((e) => [e.type, (e as { path: string }).path, e.certainty])).toEqual([
      ["file.created", "/w/new.md", "inferred"],
      ["file.changed", "/w/a.md", "known"]
    ])
    expect(events.find((e) => e.type === "tool.failed")).toMatchObject({ message: "No matches found" })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("plans, titles, compaction, wrapped prompts and monitor events", () => {
    const events = normalize([
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "<user_query>\nfix it\n</user_query>" } }, { promptIndex: 0 }),
      line({ sessionUpdate: "plan", entries: [{ content: "Fix", status: "in_progress", priority: "high" }, { content: "Test", status: "pending" }] }),
      line({ sessionUpdate: "session_info_update", title: "Fix the bug" }),
      line({ sessionUpdate: "auto_compact_completed", tokens_before: 9000, tokens_after: 1200 }),
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "<monitor-event>build finished</monitor-event>" } }),
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "next" } }, { promptIndex: 1 })
    ])
    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "turn.started",
      "user.message",
      "plan.updated",
      "context.compacted",
      "harness.notice",
      "turn.completed",
      "turn.started",
      "user.message"
    ])
    expect(events.find((e) => e.type === "user.message")).toMatchObject({ content: [{ type: "text", text: "fix it" }] })
    expect(events.find((e) => e.type === "harness.notice")).toMatchObject({ kind: "task_notification" })
    expect(events.find((e) => e.type === "turn.completed")).toMatchObject({ certainty: "inferred", outcome: "unknown" })
    expect(events.find((e) => e.type === "plan.updated")).toMatchObject({
      entries: [{ content: "Fix", status: "in_progress", priority: "high" }, { content: "Test", status: "pending" }]
    })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("forks and restores are relationships; subagents are parents", () => {
    const self = makeSessionId("grok", "child")
    expect(summaryMetadata({ parent_session_id: "src" }, self).relationships).toEqual([{ type: "fork", from: self, to: "grok:src" }])
    expect(summaryMetadata({ parent_session_id: "src", session_kind: "subagent" }, self).relationships).toBeUndefined()
    expect(summaryMetadata({ generated_title: "Mine", title_is_manual: true }, self).title).toEqual({ value: "Mine", priority: 40 })
  })

  it("helpers", () => {
    expect(exitCodeOf({ exit_code: 2 }, "")).toBe(2)
    expect(exitCodeOf({ Bash: { exit_code: 3 } }, "")).toBe(3)
    expect(exitCodeOf(undefined, "out\nExit code: 1")).toBe(1)
    expect(exitCodeOf("ok", "ok")).toBeUndefined()
    expect(unwrapUserQuery("<user_query>\nhi\n</user_query>")).toBe("hi")
    expect(unwrapUserQuery("plain")).toBe("plain")
    expect(noticeKindOf("<system-reminder>x</system-reminder>")).toBe("injected_context")
    expect(noticeKindOf("<user_info>x</user_info>")).toBe("injected_context")
    expect(noticeKindOf("hello")).toBeUndefined()
    expect(grokToolKind("run_terminal_command")).toBe("execute")
    expect(grokToolKind("spawn_subagent")).toBe("other")
  })
})
