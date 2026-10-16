import { Bridge, HostEnvironment, loadSession, sequenceEvents } from "@agentbridge/core"
import { makeSessionId, type SessionEvent } from "@agentbridge/schema"
import {
  adapterContract,
  bridgeWithAdapter,
  checkEventInvariants,
  expectGolden,
  fixturesDir,
  semanticProjection
} from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { decodeLine, initialState, normalizeLine, onHalt, type View } from "../src/CopilotNormalizer.ts"
import {
  classifyCopilotFile,
  classifyUserMessage,
  CopilotAdapter,
  exitCodeOf,
  parseWorkspaceYaml,
  todoEntries,
  workspaceTitle
} from "../src/index.ts"
import { COPILOT_SESSION, COPILOT_SUBAGENT } from "./generate-fixture.ts"

/** The §63 scenario as recorded by GitHub Copilot CLI, and its inline subagent. */
export const copilotScenario = {
  copilot: `copilot:${COPILOT_SESSION}`,
  copilotSubagent: `copilot:${COPILOT_SESSION}/${COPILOT_SUBAGENT}`
} as const
const copilotFixtureHome = `${fixturesDir}copilot`

const layer = bridgeWithAdapter(CopilotAdapter, CopilotAdapter.layer, HostEnvironment.layer({ COPILOT_HOME: copilotFixtureHome }))

adapterContract({ harness: "copilot", layer, expectedSessions: [copilotScenario.copilot], damagedSession: copilotScenario.copilot })

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("copilot", () => {
  it.effect("golden files", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(copilotScenario.copilot)))
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(copilotScenario.copilotSubagent)))
    }).pipe(Effect.provide(layer)))

  it.effect("the scenario projects to the reference steps; subagent work stays out of the parent", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session, warnings } = yield* bridge.sessions.get(copilotScenario.copilot)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:00.000Z",
        harness: { id: "copilot", name: "GitHub Copilot CLI", version: "1.0.98" },
        metadata: { model: "claude-sonnet-4.5", gitBranch: "main", repository: "acme/demo" },
        relationships: [{ type: "child", from: copilotScenario.copilot, to: copilotScenario.copilotSubagent }]
      })
      expect(warnings.map((w) => w.code).sort()).toEqual(["malformed_json", "unknown_record_type"])
      const events = yield* Stream.runCollect(bridge.sessions.events(copilotScenario.copilot))
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Add a Usage section to README.md and make sure the tests pass."],
        ["read", "README.md"],
        ["changed", "README.md"],
        ["command", "npm test", "failed"],
        ["created", "docs/usage.md"],
        ["command", "npm test", "succeeded"],
        ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
      ])
      expect(events.filter((e) => e.type === "command.completed").map((e) => e.exitCode)).toEqual([1, 0])
      expect(events.filter((e) => e.type === "command.completed").map((e) => e.stdout)).toEqual([
        "1 failing: usage section missing example",
        "2 passing"
      ])
      expect(events.filter((e) => e.type === "harness.notice").map((e) => e.kind)).toEqual(["injected_context"])
      expect(events.filter((e) => e.type === "tool.started").map((e) => [e.name, e.kind])).toEqual([
        ["view", "read"],
        ["edit", "edit"],
        ["bash", "execute"],
        ["task", "other"],
        ["create", "edit"],
        ["bash", "execute"]
      ])
      // One prompt, one run: the agent loop's per-call turn markers are not canonical turns.
      expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => [e.type, (e as { outcome?: string }).outcome]))
        .toEqual([["turn.started", undefined], ["turn.completed", "completed"]])
      expect(events.filter((e) => e.type === "agent.reasoning")).toHaveLength(1)
      expect(events.filter((e) => e.type === "usage.recorded").map((e) => e.outputTokens)).toEqual([30, 30, 30, 30, 30, 30, 18])
      expect(checkEventInvariants(events)).toEqual([])
    }).pipe(Effect.provide(layer)))

  it.effect("inline subagents resolve as linked child sessions of the same file", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const parent = yield* bridge.sessions.describe(copilotScenario.copilot)
      const { session, warnings } = yield* bridge.sessions.get(copilotScenario.copilotSubagent)
      expect(session).toMatchObject({
        parentSessionId: copilotScenario.copilot,
        agentLabel: "Explore Agent",
        projectPath: "/work/demo",
        title: "Find all TODO comments in src/.",
        metadata: { model: "claude-haiku-4.5" }
      })
      expect(warnings).toEqual([])
      const child = yield* bridge.sessions.describe(copilotScenario.copilotSubagent)
      expect(child.sourcePath).toBe(parent.sourcePath)
      const events = yield* Stream.runCollect(bridge.sessions.events(copilotScenario.copilotSubagent))
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Find all TODO comments in src/."],
        ["agent", "There are no TODO comments in src/."]
      ])
      expect(events.map((e) => e.type)).toEqual([
        "session.started",
        "turn.started",
        "user.message",
        "usage.recorded",
        "tool.started",
        "tool.completed",
        "usage.recorded",
        "agent.message",
        "turn.completed"
      ])
      expect(checkEventInvariants(events)).toEqual([])
      const missing = yield* Effect.flip(bridge.sessions.get(`copilot:${COPILOT_SESSION}/call_unknown`))
      expect(missing._tag).toBe("SessionNotFound")
    }).pipe(Effect.provide(layer)))

  it("reads workspace.yaml scalars and classifies session files", () => {
    const workspace = parseWorkspaceYaml(
      "id: abc\ncwd: /Users/me/my app\nname: 'It''s: done'\nsummary: \"Fix \\\"quoted\\\" bug\"\nbranch: ~\nuser_named: true\ncreated_at: 2026-01-01T00:00:00.000Z\n"
    )
    expect(workspace).toEqual({ id: "abc", cwd: "/Users/me/my app", name: "It's: done", summary: "Fix \"quoted\" bug", created_at: "2026-01-01T00:00:00.000Z" })
    expect(workspaceTitle({ summary: "Generated", name: "  " })).toBe("Generated")
    expect(classifyCopilotFile(["abc", "events.jsonl"], "/a")).toEqual({ path: "/a", nativeId: "abc" })
    expect(classifyCopilotFile(["abc.jsonl"], "/a")).toBeUndefined()
    expect(classifyCopilotFile(["abc", "checkpoints", "events.jsonl"], "/a")).toBeUndefined()
  })

  it("classifies user-role text, exit codes and todo checklists", () => {
    expect(classifyUserMessage({})).toEqual({ _tag: "Prompt" })
    expect(classifyUserMessage({ source: "schedule-3" })).toEqual({ _tag: "Prompt" })
    expect(classifyUserMessage({ source: "skill-pdf" })).toEqual({ _tag: "Notice", kind: "injected_context" })
    expect(classifyUserMessage({ source: "agent-explore-1" })).toEqual({ _tag: "Notice", kind: "task_notification" })
    expect(classifyUserMessage({ isAutopilotContinuation: true })).toEqual({ _tag: "Notice", kind: "other" })
    const complete = (extra: object) => ({ toolCallId: "c", success: true, ...extra })
    expect(exitCodeOf(complete({ shellExecution: { exitCode: 3 }, result: { content: "<exited with exit code 0>" } }))).toBe(3)
    expect(exitCodeOf(complete({ result: { content: "", contents: [{ type: "shell_exit", exitCode: 2, shellId: "1" }] } }))).toBe(2)
    expect(exitCodeOf(complete({ result: { content: "out\n<exited with exit code 127>" } }))).toBe(127)
    expect(exitCodeOf(complete({ result: { content: "<command with shellId: 4 is still running after 30 seconds>" } }))).toBeUndefined()
    expect(todoEntries("- [x] Read README\n- [ ] Add usage\n- [~] Run tests\nnotes")).toEqual([
      { content: "Read README", status: "completed" },
      { content: "Add usage", status: "pending" },
      { content: "Run tests", status: "in_progress" }
    ])
  })
})

/** Run the pure normalizer over in-memory events. */
const normalize = (records: ReadonlyArray<object>, view: View = { _tag: "Root" }) => {
  const sessionId = makeSessionId("copilot", view._tag === "Root" ? "s" : `s/${view.agentId}`)
  return Effect.runSync(
    Stream.fromIterable(records.map((r, index) => ({ index, line: JSON.stringify(r) }))).pipe(
      Stream.map(decodeLine),
      Stream.mapAccum(() => initialState(sessionId, "/events.jsonl", "s", view), normalizeLine, { onHalt }),
      sequenceEvents(sessionId),
      Stream.runCollect
    )
  )
}

let seq = 0
const ev = (type: string, data: object, extra: object = {}) => ({ type, data, id: `id-${++seq}`, timestamp: "2026-09-01T10:00:00.000Z", parentId: null, ...extra })
const start = ev("session.start", { sessionId: "s", copilotVersion: "1.0.62", startTime: "2026-09-01T10:00:00.000Z", context: { cwd: "/w" } })
const prompt = (content: string, extra: object = {}) => ev("user.message", { content, ...extra })
const message = (content: string, extra: object = {}) => ev("assistant.message", { messageId: `m${++seq}`, content, toolRequests: [], ...extra })
const toolStart = (toolCallId: string, toolName: string, args: unknown) => ev("tool.execution_start", { toolCallId, toolName, arguments: args })
const toolDone = (toolCallId: string, success: boolean, content: string, extra: object = {}) =>
  ev("tool.execution_complete", { toolCallId, success, result: { content }, ...extra })
const types = (events: ReadonlyArray<SessionEvent>) => events.map((e) => e.type)
const turns = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) => (e.type === "turn.completed" ? [[e.outcome, e.certainty]] : []))

describe("copilot normalization", () => {
  it("a run ends at the model call that requested no tools; abort interrupts it", () => {
    expect(turns(normalize([
      start,
      prompt("go"),
      ev("assistant.turn_start", { turnId: "0" }),
      message("", { toolRequests: [{ toolCallId: "c1", name: "view", arguments: { path: "/w/a" } }] }),
      ev("assistant.turn_end", { turnId: "0" }),
      ev("assistant.turn_start", { turnId: "1" }),
      message("done"),
      ev("assistant.turn_end", { turnId: "1" })
    ]))).toEqual([["completed", "known"]])
    expect(turns(normalize([start, prompt("go"), ev("abort", { reason: "user_initiated" }), prompt("again")])))
      .toEqual([["interrupted", "known"]])
    // A prompt arriving while a run had no recorded end closes it as unknown.
    expect(turns(normalize([start, prompt("one"), prompt("two")]))).toEqual([["unknown", "inferred"]])
    // Steering joins the run in flight.
    expect(normalize([start, prompt("one"), prompt("also this", { delivery: "steering" })]).filter((e) => e.type === "turn.started"))
      .toHaveLength(1)
  })

  it("chunks of one model call are one reply, counted once for usage", () => {
    const events = normalize([
      start,
      prompt("go"),
      message("First part.", { apiCallId: "a1", chunkIndex: 0, chunkCount: 2, outputTokens: 50, reasoningText: "think 1" }),
      message("Second part.", { apiCallId: "a1", chunkIndex: 1, chunkCount: 2, outputTokens: 50, reasoningText: "think 2" })
    ])
    expect(events.filter((e) => e.type === "agent.message").map((e) => e.content)).toEqual([[{ type: "text", text: "First part.\n\nSecond part." }]])
    expect(events.filter((e) => e.type === "agent.reasoning").map((e) => e.content)).toEqual(["think 1", "think 2"])
    expect(events.filter((e) => e.type === "usage.recorded").map((e) => e.outputTokens)).toEqual([50])
    // A series cut short is still emitted, at the end of the file.
    const cut = normalize([start, message("Only part.", { apiCallId: "a2", chunkIndex: 0, chunkCount: 3 })])
    expect(cut.filter((e) => e.type === "agent.message")).toHaveLength(1)
    expect(checkEventInvariants(cut)).toEqual([])
  })

  it("reasoning repeated by assistant.reasoning is read once", () => {
    const events = normalize([start, ev("assistant.reasoning", { reasoningId: "r", content: "hmm" }), message("ok", { reasoningText: "hmm" })])
    expect(events.filter((e) => e.type === "agent.reasoning")).toHaveLength(1)
  })

  it("tool calls: resumed starts are not repeated, a missing start falls back to the request", () => {
    const events = normalize([
      start,
      toolStart("c1", "bash", { command: "ls" }),
      ev("session.resume", { resumeTime: "2026-09-01T11:00:00.000Z", eventCount: 3 }),
      toolStart("c1", "bash", { command: "ls" }),
      toolDone("c1", true, "a\n<exited with exit code 0>"),
      message("", { toolRequests: [{ toolCallId: "c2", name: "view", arguments: { path: "/w/b" } }] }),
      toolDone("c2", true, "1. b")
    ])
    expect(types(events)).toEqual([
      "session.started",
      "tool.started",
      "command.started",
      "tool.completed",
      "command.completed",
      "tool.started",
      "tool.completed",
      "file.read"
    ])
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("commands: failures without exit codes fail, background commands stay open", () => {
    const denied = normalize([start, toolStart("c1", "bash", { command: "rm -rf /" }), toolDone("c1", false, "", { error: { message: "Permission denied" } })])
    expect(denied.at(-1)).toMatchObject({ type: "command.completed", outcome: "failed" })
    expect(denied.at(-2)).toMatchObject({ type: "tool.failed", message: "Permission denied" })
    const background = normalize([start, toolStart("c1", "bash", { command: "npm run dev", mode: "async" }), toolDone("c1", true, "<command started in background with shellId: 3>")])
    expect(types(background)).toEqual(["session.started", "tool.started", "command.started", "tool.completed"])
  })

  it("file effects come only from successful calls; fileEdits win over arguments", () => {
    const effects = (records: ReadonlyArray<object>) =>
      normalize([start, ...records]).filter((e) => e.type.startsWith("file.")).map((e) => [e.type, (e as { path: string }).path])
    expect(effects([toolStart("c", "create", { path: "/w/a", file_text: "x" }), toolDone("c", false, "exists")])).toEqual([])
    expect(effects([toolStart("c", "str_replace_editor", { command: "create", path: "/w/a" }), toolDone("c", true, "ok")])).toEqual([["file.created", "/w/a"]])
    expect(effects([
      toolStart("c", "apply_patch", { input: "*** Begin Patch\n*** Add File: /w/new\n+x\n*** Delete File: /w/old\n*** End Patch" }),
      toolDone("c", true, "Done", { fileEdits: [{ kind: "create", path: "/w/new" }, { kind: "delete", path: "/w/old" }, { kind: "edit", path: "/w/c" }] })
    ])).toEqual([["file.created", "/w/new"], ["file.deleted", "/w/old"], ["file.changed", "/w/c"]])
    expect(effects([toolStart("c", "apply_patch", "*** Begin Patch\n*** Update File: /w/u\n*** End Patch"), toolDone("c", true, "Done")]))
      .toEqual([["file.changed", "/w/u"]])
  })

  it("update_todo checklists become plans", () => {
    const events = normalize([start, toolStart("t", "update_todo", { todos: "- [x] a\n- [ ] b" }), toolDone("t", true, "TODO list updated")])
    expect(events.at(-1)).toMatchObject({ type: "plan.updated", entries: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] })
  })

  it("subagent views: attribution by agentId or the older parentToolCallId; failures are notices", () => {
    const records = [
      start,
      toolStart("task1", "task", { prompt: "look around", description: "Look" }),
      ev("subagent.started", { toolCallId: "task1", agentName: "explore" }, { agentId: "task1" }),
      ev("tool.execution_start", { toolCallId: "g", toolName: "glob", arguments: { pattern: "*" }, parentToolCallId: "task1" }),
      ev("tool.execution_complete", { toolCallId: "g", success: true, result: { content: "a" }, parentToolCallId: "task1" }),
      ev("subagent.failed", { toolCallId: "task1", agentName: "explore", error: "model unavailable" }, { agentId: "task1" }),
      toolDone("task1", false, "", { error: "model unavailable" })
    ]
    const root = normalize(records)
    expect(types(root)).toEqual(["session.started", "tool.started", "tool.failed"])
    const child = normalize(records, { _tag: "Agent", agentId: "task1" })
    expect(types(child)).toEqual([
      "session.started",
      "turn.started",
      "user.message",
      "tool.started",
      "tool.completed",
      "harness.notice",
      "turn.completed"
    ])
    expect(child.at(-1)).toMatchObject({ outcome: "failed" })
    expect(checkEventInvariants(child)).toEqual([])
  })

  it.effect("forked sessions record where they were forked from", () =>
    Effect.gen(function*() {
      const sessionId = makeSessionId("copilot", "new")
      const lines = [
        start,
        ev("session.info", { infoType: "fork", message: "Forked from \"Fix bug\" (11111111-2222-4333-8444-555555555555) as \"Fix bug 2\" (new)." })
      ]
      const emissions = Stream.fromIterable(lines.map((r, index) => ({ index, line: JSON.stringify(r) }))).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/e.jsonl", "new", { _tag: "Root" }), normalizeLine, { onHalt })
      )
      const descriptor = { id: sessionId, harness: "copilot", nativeId: "new", sourcePath: "/e.jsonl", sizeBytes: 1 } as const
      const base = { harness: { id: "copilot", name: "GitHub Copilot CLI" }, capabilities: {} } as never
      const { session } = yield* loadSession(descriptor as never, base, emissions)
      expect(session.relationships).toEqual([{ type: "fork", from: "copilot:new", to: "copilot:11111111-2222-4333-8444-555555555555" }])
    }))
})
