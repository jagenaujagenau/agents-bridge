import { Bridge, HostEnvironment, sequenceEvents } from "@agentbridge/core"
import { makeSessionId, type SessionEvent } from "@agentbridge/schema"
import {
  adapterContract,
  bridgeWithAdapter,
  checkEventInvariants,
  expectGolden,
  fixturesDir,
  semanticProjection
} from "@agentbridge/testing"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { decodeLine, initialState, normalizeLine } from "../src/KimiNormalizer.ts"
import { bashStatus, classifyKimiFile, classifyOrigin, KimiAdapter, stateFacts, todoEntries } from "../src/index.ts"
import { KIMI_DECOY_TOKEN, KIMI_SESSION, KIMI_SUBAGENT } from "./generate-fixture.ts"

/** The §63 scenario as recorded by Kimi Code, and its Agent-tool subagent. */
export const kimiScenario = {
  kimi: `kimi:${KIMI_SESSION}`,
  kimiSubagent: `kimi:${KIMI_SUBAGENT}`
} as const

/** `KIMI_CODE_HOME`: holds `sessions/`, `session_index.jsonl` and the decoy credentials. */
const kimiFixtureHome = `${fixturesDir}kimi`

/** Every path the adapter opens, to prove the decoy credentials are never read. */
const opened: Array<string> = []
const SpyFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spy: FileSystem.FileSystem = {
      ...fs,
      open: (path, options) => (opened.push(path), fs.open(path, options)),
      readFile: (path) => (opened.push(path), fs.readFile(path)),
      readFileString: (path, encoding) => (opened.push(path), fs.readFileString(path, encoding)),
      stream: (path, options) => (opened.push(path), fs.stream(path, options))
    }
    return spy
  })
).pipe(Layer.provide(NodeServices.layer))

const layer = bridgeWithAdapter(
  KimiAdapter,
  KimiAdapter.layer.pipe(Layer.provide(SpyFileSystem)),
  HostEnvironment.layer({ KIMI_CODE_HOME: kimiFixtureHome })
)

adapterContract({
  harness: "kimi",
  layer,
  expectedSessions: [kimiScenario.kimi, kimiScenario.kimiSubagent],
  damagedSession: kimiScenario.kimi
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("kimi golden files", () => {
  it.effect("scenario session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(kimiScenario.kimi)))
    }).pipe(Effect.provide(layer)))

  it.effect("subagent session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(kimiScenario.kimiSubagent)))
    }).pipe(Effect.provide(layer)))
})

describe("kimi normalization", () => {
  it.effect("session metadata comes from state.json and the wire", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session, warnings } = yield* bridge.sessions.get(kimiScenario.kimi)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        harness: { id: "kimi", name: "Kimi Code" },
        startedAt: "2026-09-01T10:00:00.000Z",
        status: "unknown",
        metadata: { model: "kimi-k2.6", wireProtocolVersion: "1.5" },
        relationships: [{ type: "child", from: kimiScenario.kimi, to: kimiScenario.kimiSubagent }]
      })
      expect(session.capabilities).toMatchObject({ tokenUsage: true, toolResults: true })
      expect(warnings.map((w) => w.code).sort()).toEqual(["malformed_json", "unknown_record_type"])

      const sub = yield* bridge.sessions.get(kimiScenario.kimiSubagent)
      expect(sub.session).toMatchObject({
        parentSessionId: kimiScenario.kimi,
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:09.000Z",
        title: "Find all TODO comments in src/."
      })
      const descriptor = yield* bridge.sessions.describe(kimiScenario.kimiSubagent)
      expect(descriptor.agentLabel).toBe("explore")
    }).pipe(Effect.provide(layer)))

  it.effect("produces the reference scenario", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(kimiScenario.kimi)
      const events = yield* Stream.runCollect(bridge.sessions.events(kimiScenario.kimi))
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
      expect(events.filter((e) => e.type === "harness.notice").map((e) => e.kind)).toEqual(["injected_context"])
      expect(events.filter((e) => e.type === "tool.started").map((e) => [e.name, e.kind])).toEqual([
        ["Read", "read"],
        ["Edit", "edit"],
        ["Bash", "execute"],
        ["Agent", "other"],
        ["Write", "edit"],
        ["Bash", "execute"]
      ])
      // The exit code is recorded only in a failed result's text; success records none.
      const commands = events.filter((e) => e.type === "command.completed")
      expect(commands.map((e) => [e.outcome, e.exitCode, e.stdout])).toEqual([
        ["failed", 1, "1 failing: usage section missing example"],
        ["succeeded", undefined, "2 passing\n"]
      ])
      expect(events.find((e) => e.type === "command.started")).toMatchObject({ command: "npm test", cwd: "/work/demo" })
      // Paths come from the tool display, resolved against the working directory.
      expect(events.filter((e) => e.type.startsWith("file.")).map((e) => [e.type, (e as { path: string }).path, e.certainty])).toEqual([
        ["file.read", "/work/demo/README.md", "known"],
        ["file.changed", "/work/demo/README.md", "known"],
        ["file.created", "/work/demo/docs/usage.md", "inferred"]
      ])
      expect(events.find((e) => e.type === "agent.reasoning")).toMatchObject({
        content: "I should read the README first.",
        representation: "provider_exposed"
      })
    }).pipe(Effect.provide(layer)))

  it.effect("usage: one event per model call, in canonical semantics", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(kimiScenario.kimi))
      const usage = events.filter((e) => e.type === "usage.recorded")
      expect(usage).toHaveLength(7)
      expect(usage[1]).toMatchObject({ model: "kimi-k2.6", inputTokens: 300, cacheReadTokens: 1700, cacheWriteTokens: 0, outputTokens: 80 })
      // `step.end` repeats the usage; it is read once, from `usage.record`.
      const sub = yield* Stream.runCollect(bridge.sessions.events(kimiScenario.kimiSubagent))
      expect(sub.filter((e) => e.type === "usage.recorded")).toHaveLength(2)
    }).pipe(Effect.provide(layer)))

  it.effect("turns come from turn.prompt and turn.ended", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      for (const id of [kimiScenario.kimi, kimiScenario.kimiSubagent]) {
        const events = yield* Stream.runCollect(bridge.sessions.events(id))
        expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => [e.type, e.certainty, (e as { turnId: string }).turnId]))
          .toEqual([["turn.started", "known", "0"], ["turn.completed", "known", "0"]])
        expect(events.at(-1)).toMatchObject({ type: "turn.completed", outcome: "completed" })
      }
    }).pipe(Effect.provide(layer)))

  it.effect("the subagent matches the reference subagent", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(kimiScenario.kimiSubagent)
      const events = yield* Stream.runCollect(bridge.sessions.events(kimiScenario.kimiSubagent))
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Find all TODO comments in src/."],
        ["agent", "There are no TODO comments in src/."]
      ])
      expect(events.find((e) => e.type === "tool.started")).toMatchObject({ name: "Grep", kind: "search" })
    }).pipe(Effect.provide(layer)))

  it.effect("never opens config.toml or credentials", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      opened.length = 0
      const listed = yield* Stream.runCollect(bridge.sessions.list({ harness: "kimi" }))
      for (const descriptor of listed) yield* Stream.runDrain(bridge.sessions.events(descriptor.id))
      expect(opened.length).toBeGreaterThan(0)
      expect(opened.filter((p) => p.includes("credentials") || p.endsWith("config.toml") || p.endsWith("session_index.jsonl"))).toEqual([])
      expect(opened.every((p) => p.startsWith(`${kimiFixtureHome}/sessions/`))).toBe(true)
      for (const descriptor of listed) {
        const text = JSON.stringify(yield* Stream.runCollect(bridge.sessions.events(descriptor.id)))
        expect(text).not.toContain(KIMI_DECOY_TOKEN)
      }
    }).pipe(Effect.provide(layer)))

  it("discovers agent wires and skips sidecars", () => {
    const s = "session_0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d"
    expect(classifyKimiFile(["wd_x_0123456789ab", s, "agents", "main", "wire.jsonl"], "/x")?.nativeId).toBe(s)
    expect(classifyKimiFile(["wd_x_0123456789ab", s, "agents", "agent-3", "wire.jsonl"], "/x")?.nativeId).toBe(`${s}/agent-3`)
    expect(classifyKimiFile(["wd_x_0123456789ab", s, "state.json"], "/x")).toBeUndefined()
    expect(classifyKimiFile(["wd_x_0123456789ab", s, "agents", "main", "tasks", "bash-1.json"], "/x")).toBeUndefined()
    expect(classifyKimiFile(["wd_x_0123456789ab", s, "agents", "main", "blobs", "abc"], "/x")).toBeUndefined()
  })

  it("links nested subagents to the agent that spawned them", () => {
    const state = {
      cwd: "/w",
      createdAt: 1_788_256_800_000,
      agents: {
        main: { type: "main", parentAgentId: null },
        "agent-1": { type: "sub", parentAgentId: "main", labels: { parentAgentId: "main", profileName: "coder" } },
        "agent-2": { type: "sub", parentAgentId: "main", labels: { parentAgentId: "agent-1" } }
      }
    }
    expect(stateFacts(state, "s")).toEqual({ projectPath: "/w", startedAt: "2026-09-01T10:00:00.000Z" })
    expect(stateFacts(state, "s/agent-1")).toMatchObject({ parentNativeId: "s", agentLabel: "coder" })
    expect(stateFacts(state, "s/agent-2")).toMatchObject({ parentNativeId: "s/agent-1" })
    expect(stateFacts(undefined, "s/agent-9")).toEqual({ parentNativeId: "s" })
  })

  it("reads Bash exit codes only from failed results", () => {
    expect(bashStatus("boom\nCommand failed with exit code: 2.", true)).toEqual({ outcome: "failed", exitCode: 2, stdout: "boom", background: false })
    expect(bashStatus("Process exited with code 3\nCommand failed with exit code: 3.", true)).toMatchObject({ exitCode: 3, stdout: "" })
    expect(bashStatus("Command executed successfully.", false)).toEqual({ outcome: "succeeded", stdout: "", background: false })
    expect(bashStatus("partial\nCommand killed by timeout (60s)", true)).toMatchObject({ outcome: "interrupted" })
    expect(bashStatus("Interrupted by user", true)).toMatchObject({ outcome: "interrupted" })
    expect(bashStatus("task_id: bash-1a2b3c4d\npid: 7\ndescription: d\nstatus: running\nautomatic_notification: true\nnext_step: …", false))
      .toMatchObject({ background: true })
  })

  it("classifies message origins", () => {
    expect(classifyOrigin(undefined)).toEqual({ _tag: "Prompt" })
    expect(classifyOrigin({ kind: "system_trigger", name: "subagent" })).toEqual({ _tag: "Prompt" })
    expect(classifyOrigin({ kind: "system_trigger", name: "stop_hook" })).toEqual({ _tag: "Notice", kind: "hook" })
    expect(classifyOrigin({ kind: "injection", variant: "plan_mode" })).toEqual({ _tag: "Notice", kind: "injected_context" })
    expect(classifyOrigin({ kind: "task", taskId: "x", status: "completed", notificationId: "n" })).toEqual({ _tag: "Notice", kind: "task_notification" })
    expect(classifyOrigin({ kind: "skill_activation", trigger: "user-slash", skillName: "review", skillArgs: "src", activationId: "a" }))
      .toEqual({ _tag: "Slash", text: "/review src" })
    expect(classifyOrigin({ kind: "skill_activation", trigger: "model-tool", skillName: "review", activationId: "a" }))
      .toEqual({ _tag: "Notice", kind: "injected_context" })
    expect(classifyOrigin({ kind: "compaction_summary" })).toEqual({ _tag: "Skip" })
  })

  it("maps TodoList items to plan entries", () => {
    expect(todoEntries([{ title: "Edit", status: "done" }, { title: "Test", status: "in_progress" }])).toEqual([
      { title: "Edit", content: "Edit", status: "completed" },
      { title: "Test", content: "Test", status: "in_progress" }
    ])
  })
})

describe("kimi records beyond the scenario", () => {
  const sessionId = makeSessionId("kimi", "s")
  const normalize = (records: ReadonlyArray<object | string>) =>
    Effect.runSync(
      Stream.fromIterable(records.map((r, index) => ({ index, line: typeof r === "string" ? r : JSON.stringify(r) }))).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/w.jsonl", "s"), normalizeLine),
        sequenceEvents(sessionId),
        Stream.runCollect
      )
    )
  const at = (s: number) => Date.parse("2026-09-01T10:00:00.000Z") + s * 1000
  const loop = (s: number, event: object) => ({ type: "context.append_loop_event", agentId: "main", event, time: at(s) })
  const message = (s: number, msg: object) => ({ type: "context.append_message", agentId: "main", message: { toolCalls: [], ...msg }, time: at(s) })
  const user = (s: number, text: string, origin: object = { kind: "user" }) => message(s, { role: "user", content: [{ type: "text", text }], origin })
  const turnPrompt = (s: number, turnId?: number) => ({ type: "turn.prompt", agentId: "main", input: [], origin: { kind: "user" }, ...(turnId !== undefined ? { turnId } : {}), time: at(s) })
  const call = (s: number, toolCallId: string, name: string, args: object) =>
    loop(s, { type: "tool.call", uuid: `u-${toolCallId}`, toolCallId, name, args })
  const result = (s: number, toolCallId: string, output: unknown, isError?: boolean) =>
    loop(s, { type: "tool.result", parentUuid: `u-${toolCallId}`, toolCallId, result: { output, ...(isError !== undefined ? { isError } : {}) } })
  const types = (events: ReadonlyArray<SessionEvent>) => events.map((e) => e.type)

  it("TodoList calls update the plan; read-only calls and failures do not", () => {
    const events = normalize([
      user(0, "plan it"),
      call(1, "t1", "TodoList", { todos: [{ title: "Edit", status: "done" }, { title: "Test", status: "pending" }] }),
      result(2, "t1", "Todo list updated."),
      call(3, "t2", "TodoList", {}),
      result(4, "t2", "1. [done] Edit"),
      call(5, "t3", "TodoList", { todos: [{ title: "x", status: "pending" }] }),
      result(6, "t3", "denied", true)
    ])
    const plans = events.filter((e) => e.type === "plan.updated")
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ entries: [{ content: "Edit", status: "completed" }, { content: "Test", status: "pending" }] })
    expect(plans[0]?.parentEventId).toBe(events.find((e) => e.type === "tool.started")?.id)
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("compaction, injected parts, hooks, task notifications and failed turns", () => {
    const events = normalize([
      turnPrompt(0, 0),
      message(0, {
        role: "user",
        content: [
          { type: "text", text: "<skill>review body</skill>" },
          { type: "text", text: "<hook>be careful</hook>", meta: { source: "user prompt submit hook" } },
          { type: "text", text: "review src" }
        ],
        origin: { kind: "user", skillActivations: [{ activationId: "a1", skillName: "review" }] }
      }),
      { type: "turn.ended", agentId: "main", turnId: 0, reason: "failed", error: { code: "provider.api_error", message: "429 Too Many Requests" }, time: at(1) },
      { type: "context.apply_compaction", agentId: "main", summary: "Summary so far", compactedCount: 4, tokensBefore: 9000, time: at(2) },
      user(3, "Task bash-1 completed", { kind: "task", taskId: "bash-1", status: "completed", notificationId: "n1" }),
      user(4, "keep going", { kind: "system_trigger", name: "stop_hook" }),
      message(5, { role: "assistant", content: [{ type: "text", text: "Blocked by hook" }], origin: { kind: "hook_result", event: "UserPromptSubmit", blocked: true } }),
      turnPrompt(6, 1),
      user(6, "/review src", { kind: "skill_activation", trigger: "user-slash", skillName: "review", skillArgs: "src", activationId: "a2" }),
      { type: "turn.ended", agentId: "main", turnId: 1, reason: "cancelled", time: at(7) }
    ])
    expect(events.map((e) => [e.type, "kind" in e ? e.kind : "outcome" in e ? e.outcome : undefined])).toEqual([
      ["session.started", undefined],
      ["turn.started", undefined],
      ["harness.notice", "injected_context"],
      ["harness.notice", "hook"],
      ["user.message", undefined],
      ["harness.notice", "error"],
      ["turn.completed", "failed"],
      ["context.compacted", undefined],
      ["harness.notice", "task_notification"],
      ["harness.notice", "hook"],
      ["harness.notice", "hook"],
      ["turn.started", undefined],
      ["user.message", undefined],
      ["harness.notice", "injected_context"],
      ["turn.completed", "interrupted"]
    ])
    expect(events.find((e) => e.type === "user.message")).toMatchObject({ content: [{ type: "text", text: "review src" }] })
    expect(events.filter((e) => e.type === "user.message").at(-1)).toMatchObject({ content: [{ type: "text", text: "/review src" }] })
    expect(events.find((e) => e.type === "context.compacted")).toMatchObject({ summary: "Summary so far" })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("user shell commands (`!cmd`) become commands without an exit code", () => {
    const events = normalize([
      message(0, { role: "user", content: [{ type: "text", text: "<bash-input>\nls &amp;&amp; pwd\n</bash-input>" }], origin: { kind: "shell_command", phase: "input" }, id: "m1" }),
      message(1, {
        role: "user",
        content: [{ type: "text", text: "<bash-stdout>a.txt\n/w\n</bash-stdout><bash-stderr></bash-stderr>" }],
        origin: { kind: "shell_command", phase: "output" }
      })
    ])
    expect(events.find((e) => e.type === "user.message")).toMatchObject({ content: [{ type: "text", text: "!ls && pwd" }] })
    expect(events.find((e) => e.type === "command.started")).toMatchObject({ command: "ls && pwd" })
    const done = events.find((e) => e.type === "command.completed")
    expect(done).toMatchObject({ outcome: "succeeded", stdout: "a.txt\n/w\n" })
    expect(done && "exitCode" in done).toBe(false)
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("background Bash commands complete with the task's recorded exit code", () => {
    const events = normalize([
      user(0, "run the server checks"),
      call(1, "b1", "Bash", { command: "npm run e2e", run_in_background: true, description: "e2e" }),
      result(1, "b1", "task_id: bash-1a2b3c4d\npid: 7\ndescription: e2e\nstatus: running\nautomatic_notification: true\nnext_step: …", false),
      {
        type: "task.terminated",
        agentId: "main",
        info: { taskId: "bash-1a2b3c4d", kind: "process", command: "npm run e2e", status: "failed", exitCode: 3, parentToolCallId: "b1", detached: true },
        outputTail: "3 failing\n",
        time: at(9)
      }
    ])
    expect(types(events).filter((t) => t.startsWith("command."))).toEqual(["command.started", "command.completed"])
    expect(events.find((e) => e.type === "command.completed")).toMatchObject({ outcome: "failed", exitCode: 3, stdout: "3 failing\n" })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("imported kimi-cli wires: messages carry the transcript and turns are counted", () => {
    const events = normalize([
      { type: "metadata", protocol_version: "1.0", created_at: at(0) },
      { type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "fix it" }], origin: { kind: "user" }, time: at(0) },
      message(0, { role: "user", content: [{ type: "text", text: "fix it" }] }),
      message(0, {
        role: "assistant",
        content: [{ type: "think", think: "Look first." }, { type: "text", text: "Reading." }],
        toolCalls: [{ type: "function", id: "c1", function: { name: "Read", arguments: "{\"path\":\"/w/a.ts\"}" } }]
      }),
      message(0, { role: "tool", content: [{ type: "text", text: "1\tx" }], toolCallId: "c1" }),
      { type: "turn.ended", agentId: "main", turnId: 0, reason: "completed", time: at(0) }
    ])
    expect(types(events)).toEqual([
      "session.started",
      "turn.started",
      "user.message",
      "agent.reasoning",
      "agent.message",
      "tool.started",
      "tool.completed",
      "file.read",
      "turn.completed"
    ])
    expect(events.find((e) => e.type === "tool.started")).toMatchObject({ name: "Read", input: { path: "/w/a.ts" } })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("all-zero usage is not usage; unknown loop events are warnings", () => {
    const emissions = Effect.runSync(
      Stream.fromIterable([
        { type: "usage.record", agentId: "main", model: "m", usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: "session", time: at(0) },
        loop(1, { type: "step.future", uuid: "x" })
      ].map((r, index) => ({ index, line: JSON.stringify(r) }))).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/w.jsonl", "s"), normalizeLine),
        Stream.runCollect
      )
    )
    expect(emissions.map((e) => (e._tag === "Event" ? e.event.type : e._tag === "Warning" ? e.warning.code : e._tag))).toEqual([
      "session.started",
      "unknown_record_type"
    ])
  })

  it("a fork links to its source from state.json", () => {
    // stateMetadata is exercised through the adapter; the wire's `forked` marker is metadata only.
    const events = normalize([{ type: "forked", agentId: "main", time: at(0) }, user(1, "continue")])
    expect(types(events)).toEqual(["session.started", "user.message"])
  })
})
