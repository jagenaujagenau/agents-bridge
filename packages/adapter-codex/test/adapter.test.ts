import { Bridge, HostEnvironment, loadSession, sequenceEvents } from "@agentbridge/core"
import { makeSessionId, type SessionEvent } from "@agentbridge/schema"
import { adapterContract, bridgeWithAdapter, checkEventInvariants, codexFixtureHome, expectGolden, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { decodeLine } from "../src/CodexSource.ts"
import { initialState, normalizeLine } from "../src/CodexNormalizer.ts"
import { classifyUserText, CodexAdapter, rolloutId } from "../src/index.ts"

const layer = bridgeWithAdapter(
  CodexAdapter,
  CodexAdapter.layer,
  HostEnvironment.layer({ CODEX_HOME: codexFixtureHome })
)

adapterContract({
  harness: "codex",
  layer,
  expectedSessions: [scenario.codex, scenario.codexSubagent],
  damagedSession: scenario.codex
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("codex golden files", () => {
  it.effect("scenario session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.codex)))
    }).pipe(Effect.provide(layer)))

  it.effect("subagent session", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.codexSubagent)))
    }).pipe(Effect.provide(layer)))
})

/** Run the pure normalizer over in-memory rollout lines. */
const normalize = (lines: ReadonlyArray<unknown>) => {
  const sessionId = makeSessionId("codex", "test")
  return Effect.runSync(
    Stream.fromIterable(lines.map((line, index) => ({ index, line: JSON.stringify(line) }))).pipe(
      Stream.map(decodeLine),
      Stream.mapAccum(() => initialState(sessionId, "/rollout.jsonl"), normalizeLine),
      sequenceEvents(sessionId),
      Stream.runCollect
    )
  )
}

const meta = { timestamp: "2026-09-01T10:00:00.000Z", type: "session_meta", payload: { id: "test", cwd: "/w" } }
const call = (id: string, cmd: string) => ({
  type: "response_item",
  payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }), call_id: id }
})
const output = (id: string, text: string) => ({
  type: "response_item",
  payload: { type: "function_call_output", call_id: id, output: text }
})
const execEnd = (id: string, exit_code: number) => ({
  type: "event_msg",
  payload: { type: "exec_command_end", call_id: id, exit_code, aggregated_output: "out" }
})
const types = (events: ReadonlyArray<SessionEvent>) => events.map((e) => e.type)

describe("codex normalization", () => {
  it.effect("session metadata and forked rollouts keep their own identity", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.codex)
      expect(session).toMatchObject({
        id: scenario.codex,
        title: "Add README usage section",
        projectPath: "/work/demo",
        harness: { id: "codex", name: "Codex", version: "0.130.0" },
        metadata: { model: "gpt-5.5", gitBranch: "main" }
      })
      const sub = yield* bridge.sessions.get(scenario.codexSubagent)
      expect(sub.session).toMatchObject({ parentSessionId: scenario.codex, agentLabel: "explorer" })
    }).pipe(Effect.provide(layer)))

  it.effect("each fact comes from one record: no duplicate messages", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.codex))
      expect(events.filter((e) => e.type === "user.message")).toHaveLength(1)
      expect(events.filter((e) => e.type === "agent.message")).toHaveLength(1)
      // Encrypted reasoning with an empty summary is not reconstructed.
      expect(events.filter((e) => e.type === "agent.reasoning")).toHaveLength(1)
    }).pipe(Effect.provide(layer)))

  it.effect("forked rollouts record a fork relationship", () =>
    Effect.gen(function*() {
      const sessionId = makeSessionId("codex", "child")
      const line = { type: "session_meta", payload: { id: "child", forked_from_id: "origin" } }
      const emissions = Stream.make({ index: 0, line: JSON.stringify(line) }).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(sessionId, "/r.jsonl"), normalizeLine)
      )
      const descriptor = { id: sessionId, harness: "codex", nativeId: "child", sourcePath: "/r.jsonl", sizeBytes: 1 } as const
      const base = { harness: { id: "codex", name: "Codex" }, capabilities: {} } as never
      const { session } = yield* loadSession(descriptor as never, base, emissions)
      expect(session.relationships).toEqual([{ type: "fork", from: "codex:child", to: "codex:origin" }])
    }))

  it("turns come from task_started / task_complete / turn_aborted", () => {
    const events = normalize([
      meta,
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 900 } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "t2" } },
      { type: "event_msg", payload: { type: "turn_aborted", turn_id: "t2", reason: "interrupted" } }
    ])
    expect(events.filter((e) => e.type === "turn.completed").map((e) => [e.turnId, e.outcome, e.durationMs]))
      .toEqual([["t1", "completed", 900], ["t2", "interrupted", undefined]])
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("usage comes from last_token_usage, cached tokens split out, repeats skipped", () => {
    const count = (input: number, total: number) => ({
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 3 }, total_token_usage: { total_tokens: total } } }
    })
    const events = normalize([meta, count(100, 107), count(100, 107), count(60, 174)])
    expect(events.filter((e) => e.type === "usage.recorded")).toMatchObject([
      { inputTokens: 60, cacheReadTokens: 40, outputTokens: 7, reasoningTokens: 3 },
      { inputTokens: 20 }
    ])
  })

  it("a shell command the user ran becomes a command", () => {
    const events = normalize([meta, {
      type: "event_msg",
      payload: { type: "exec_command_end", call_id: "u1", command: ["/bin/zsh", "-lc", "git status"], cwd: "/w", exit_code: 0, aggregated_output: "clean" }
    }])
    expect(events.slice(1).map((e) => e.type)).toEqual(["command.started", "command.completed"])
    expect(events[1]).toMatchObject({ command: "git status", cwd: "/w" })
    expect(events[2]).toMatchObject({ outcome: "succeeded", exitCode: 0, stdout: "clean" })
  })

  it("exec end before output", () => {
    const events = normalize([meta, call("c1", "ls"), execEnd("c1", 2), output("c1", "Process exited with code 2")])
    expect(types(events)).toEqual(["session.started", "tool.started", "command.started", "tool.failed", "command.completed"])
    expect(events[4]).toMatchObject({ outcome: "failed", exitCode: 2, stdout: "out" })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("long-running command: output first, exec end later", () => {
    const events = normalize([meta, call("c1", "npm run dev"), output("c1", "Process running with session ID 7"), execEnd("c1", 0)])
    expect(types(events)).toEqual(["session.started", "tool.started", "command.started", "tool.completed", "command.completed"])
    expect(events[4]).toMatchObject({ outcome: "succeeded", exitCode: 0 })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("exit code from the output header when exec end is missing", () => {
    const events = normalize([meta, call("c1", "false"), output("c1", "Chunk ID: 1\nProcess exited with code 1\nOutput:\nboom")])
    expect(events.at(-1)).toMatchObject({ type: "command.completed", outcome: "failed", exitCode: 1, stdout: "boom" })
  })

  it("never-completed commands emit no completion", () => {
    const events = normalize([meta, call("c1", "sleep 100")])
    expect(types(events)).toEqual(["session.started", "tool.started", "command.started"])
  })

  it("apply_patch without patch_apply_end falls back to the patch headers", () => {
    const events = normalize([
      meta,
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "p", input: "*** Begin Patch\n*** Delete File: old.md\n*** Add File: new.md\n+x\n*** End Patch" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p", output: JSON.stringify({ output: "Success.", metadata: { exit_code: 0 } }) } }
    ])
    expect(events.filter((e) => e.type.startsWith("file.")).map((e) => [e.type, (e as { path: string }).path]))
      .toEqual([["file.deleted", "old.md"], ["file.created", "new.md"]])
  })

  it("failed patches change no files", () => {
    const events = normalize([
      meta,
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "p", input: "*** Begin Patch\n*** Update File: a.md\n*** End Patch" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p", output: "apply_patch verification failed: no such file" } }
    ])
    expect(types(events)).toEqual(["session.started", "tool.started", "tool.failed"])
  })

  it("classifies injected context and IDE wrappers", () => {
    expect(classifyUserText("<environment_context>x</environment_context>")).toEqual({ _tag: "Notice", kind: "injected_context" })
    expect(classifyUserText("# AGENTS.md instructions for /w\n...")).toEqual({ _tag: "Notice", kind: "injected_context" })
    expect(classifyUserText("# Context from my IDE setup:\n\n## Open tabs\n\n## My request for Codex:\nfix it\n"))
      .toEqual({ _tag: "Prompt", text: "fix it" })
    expect(classifyUserText("# In app browser:\n- url: http://localhost\n\n## My request for Codex:\ncheck the page"))
      .toEqual({ _tag: "Prompt", text: "check the page" })
    expect(classifyUserText("# Plan\nplain markdown prompt")).toEqual({ _tag: "Prompt", text: "# Plan\nplain markdown prompt" })
  })

  it("rollout ids come from file names", () => {
    expect(rolloutId("rollout-2026-05-20T20-17-15-019e469b-2fa4-76a0-99b2-feecde5af820.jsonl"))
      .toBe("019e469b-2fa4-76a0-99b2-feecde5af820")
    expect(rolloutId("notes.jsonl")).toBeUndefined()
  })
})
