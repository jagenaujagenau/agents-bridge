import { Bridge, HostEnvironment, sequenceEvents, SqliteReader, VersionProbe } from "@agentbridge/core"
import { NodeSqliteReader } from "@agentbridge/platform-node"
import { makeSessionId } from "@agentbridge/schema"
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
import { initialState, normalizeMessage } from "../src/CrushNormalizer.ts"
import { bashStatus, CrushAdapter } from "../src/index.ts"
import type { MessageRow } from "../src/schema/CrushRecord.ts"
import { crushScenario as scenario } from "./generate-fixture.ts"

/** CRUSH_GLOBAL_DATA: holds the project registry that points at the fixture database. */
const crushFixtureGlobalData = `${fixturesDir}crush/global`
const crushFixtureProject = `${fixturesDir}crush/projects/demo`
const crushFixtureDatabase = `${crushFixtureProject}/.crush/crush.db`

const env = (variables: Record<string, string>) =>
  bridgeWithAdapter(CrushAdapter, CrushAdapter.layer, Layer.mergeAll(HostEnvironment.layer(variables), NodeSqliteReader))

const layer = env({ CRUSH_GLOBAL_DATA: crushFixtureGlobalData, HOME: "/nonexistent-home" })

adapterContract({
  harness: "crush",
  layer,
  expectedSessions: [scenario.crush, scenario.crushSubagent],
  damagedSession: scenario.crush
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("crush golden files", () => {
  it.effect("scenario and agent sessions", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.crush)))
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.crushSubagent)))
    }).pipe(Effect.provide(layer)))
})

describe("crush normalization", () => {
  it.effect("produces the reference scenario", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.crush)
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.crush))
      expect(semanticProjection(session, events, { writes: "coarse" })).toEqual([
        ["user", "Add a Usage section to README.md and make sure the tests pass."],
        ["read", "README.md"],
        ["written", "README.md"],
        ["command", "npm test", "failed"],
        ["written", "docs/usage.md"],
        ["command", "npm test", "succeeded"],
        ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
      ])
      expect(semanticProjection(session, events)).toContainEqual(["created", "docs/usage.md"])
      expect(events.find((e) => e.type === "file.created")).toMatchObject({ certainty: "inferred" })
      // Exit codes only where Crush records them: the failing run's trailer. Success has none.
      expect(events.filter((e) => e.type === "command.completed").map((e) => [e.outcome, e.exitCode, e.durationMs]))
        .toEqual([["failed", 1, 120], ["succeeded", undefined, 120]])
      expect(events.some((e) => e.type === "usage.recorded")).toBe(false)
    }).pipe(Effect.provide(layer)))

  it.effect("turns follow agent runs; the hidden continuation is a notice", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.crush))
      expect(events.filter((e) => e.type === "user.message")).toHaveLength(1)
      expect(events.filter((e) => e.type === "harness.notice").map((e) => [e.kind, e.content]))
        .toEqual([
          ["injected_context", [{ type: "text", text: "Implement the plan." }]],
          ["interruption", [{ type: "text", text: "User canceled request" }]]
        ])
      expect(events.filter((e) => e.type === "turn.completed").map((e) => e.outcome)).toEqual(["completed", "interrupted"])
    }).pipe(Effect.provide(layer)))

  it.effect("session rows become descriptors and sessions", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const child = yield* bridge.sessions.describe(scenario.crushSubagent)
      expect(child).toMatchObject({
        parentSessionId: scenario.crush,
        agentLabel: "agent",
        projectPath: "/work/demo",
        sourcePath: crushFixtureDatabase
      })
      expect(child.sizeBytes).toBeUndefined()
      const { session } = yield* bridge.sessions.get(scenario.crush)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:01.000Z",
        status: "unknown",
        metadata: { model: "claude-opus-5", provider: "anthropic", sessionTotals: { promptTokens: 5200, completionTokens: 640, cost: 0.042 } }
      })
      expect(session.capabilities.tokenUsage).toBe(false)
      // "New Agent Session" is Crush's placeholder; the prompt names the session instead.
      expect((yield* bridge.sessions.get(scenario.crushSubagent)).session.title).toBe("Find all TODO comments in src/.")
    }).pipe(Effect.provide(layer)))

  it.effect("BRIDGE_CRUSH_PROJECTS adds databases Crush never registered", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const listed = yield* Stream.runCollect(bridge.sessions.list())
      expect(listed.map((d) => d.id).sort()).toEqual([scenario.crush, scenario.crushSubagent].sort())
      expect(listed.every((d) => d.projectPath === crushFixtureProject)).toBe(true)
    }).pipe(Effect.provide(env({ CRUSH_GLOBAL_DATA: "/nonexistent", BRIDGE_CRUSH_PROJECTS: `/nonexistent-project:${crushFixtureProject}` }))))

  it.effect("the same database through the registry and the variable is listed once", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expect(yield* Stream.runCollect(bridge.sessions.list())).toHaveLength(2)
    }).pipe(Effect.provide(env({ CRUSH_GLOBAL_DATA: crushFixtureGlobalData, BRIDGE_CRUSH_PROJECTS: crushFixtureDatabase }))))

  it.effect("no registry and no databases is an empty history, not an error", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expect(yield* Stream.runCollect(bridge.sessions.list())).toEqual([])
    }).pipe(Effect.provide(env({ CRUSH_GLOBAL_DATA: "/nonexistent", HOME: "/nonexistent-home" }))))
})

describe("crush never reads credentials", () => {
  it.effect("only projects.json and the sessions/messages tables are read", () => {
    const reads: Array<string> = []
    const queries: Array<string> = []
    const spyFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const log = (path: string) => void reads.push(path)
        return {
          ...fs,
          readFile: (path) => (log(path), fs.readFile(path)),
          readFileString: (path, encoding) => (log(path), fs.readFileString(path, encoding)),
          stream: (path, options) => (log(path), fs.stream(path, options)),
          open: (path, options) => (log(path), fs.open(path, options))
        } satisfies FileSystem.FileSystem
      })
    ).pipe(Layer.provide(NodeServices.layer))
    const spySqlite = Layer.effect(
      SqliteReader,
      Effect.gen(function*() {
        const real = yield* SqliteReader
        return { rows: (database, sql, params) => (queries.push(sql), real.rows(database, sql, params)) }
      })
    ).pipe(Layer.provide(NodeSqliteReader))
    const adapterLayer = CrushAdapter.layer.pipe(
      Layer.provide(Layer.mergeAll(
        NodeServices.layer,
        spyFileSystem,
        spySqlite,
        VersionProbe.layerNoop,
        HostEnvironment.layer({ CRUSH_GLOBAL_DATA: crushFixtureGlobalData })
      ))
    )
    return Effect.gen(function*() {
      const adapter = yield* CrushAdapter
      for (const descriptor of yield* Stream.runCollect(adapter.listSessions())) {
        yield* Stream.runDrain(adapter.read(descriptor))
      }
      yield* adapter.detect
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((path) => path.endsWith("/projects.json"))).toBe(true)
      expect(queries.length).toBeGreaterThan(0)
      for (const sql of queries) {
        expect(sql).not.toMatch(/\b(files|read_files)\b/)
        expect(sql).toMatch(/\bfrom (sessions|messages|pragma_table_info\('messages'\))(\s|$)/)
      }
    }).pipe(Effect.provide(adapterLayer))
  })
})

describe("crush records beyond the scenario", () => {
  const sessionId = makeSessionId("crush", "t")
  let at = 0
  const row = (role: string, parts: ReadonlyArray<object> | string, extra: Partial<MessageRow> = {}): MessageRow => ({
    id: `m${++at}`,
    role,
    parts: typeof parts === "string" ? parts : JSON.stringify(parts),
    model: role === "assistant" ? "m" : null,
    provider: null,
    created_at: 1788256800 + at,
    is_summary_message: 0,
    ...extra
  })
  const normalize = (rows: ReadonlyArray<MessageRow>) =>
    Effect.runSync(
      Stream.fromIterable(rows).pipe(
        Stream.zipWithIndex,
        Stream.mapAccum(() => initialState(sessionId, "/t/crush.db", "/w"), normalizeMessage),
        sequenceEvents(sessionId),
        Stream.runCollect
      )
    )
  const text = (value: string, hidden?: boolean) => ({ type: "text", data: { text: value, ...(hidden ? { hidden } : {}) } })
  const finish = (reason: string, message?: string, details?: string) =>
    ({ type: "finish", data: { reason, time: 1788256900, ...(message ? { message } : {}), ...(details ? { details } : {}) } })
  const call = (id: string, name: string, input: object) => ({ type: "tool_call", data: { id, name, input: JSON.stringify(input), finished: true } })
  const result = (id: string, content: string, metadata?: object, isError = false) =>
    ({ type: "tool_result", data: { tool_call_id: id, content, metadata: metadata ? JSON.stringify(metadata) : "", is_error: isError } })

  it("user shell commands, attachments, summaries, errors and plans", () => {
    const events = normalize([
      row("user", [{ type: "shell_command", data: { command: "ls", output: "README.md", exit_code: 0 } }, finish("stop")]),
      row("user", [text("look at this"), { type: "binary", data: { Path: "/w/shot.png", MIMEType: "image/png", Data: "AAAA" } }, finish("stop")]),
      row("assistant", [
        call("t1", "todos", { todos: [{ content: "Edit", status: "in_progress", active_form: "Editing" }, { content: "Test", status: "pending", active_form: "Testing" }] }),
        finish("tool_use")
      ]),
      row("tool", [result("t1", "Todo list updated"), finish("stop")]),
      row("assistant", [call("e1", "edit", { file_path: "/w/new.md", old_string: "", new_string: "x" }), call("e2", "multiedit", { file_path: "/w/a.md", edits: [] })]),
      row("tool", [result("e1", "File created: /w/new.md")]),
      row("tool", [result("e2", "no changes made - all 1 edit(s) failed", undefined, true)]),
      row("tool", [result("zz", "orphan")]),
      row("assistant", [finish("error", "Request timed out", "Try again")]),
      row("assistant", [text("Summary of the work so far.")], { is_summary_message: 1 }),
      row("system", [text("x")])
    ])
    expect(events.map((e) => [e.type, "kind" in e ? e.kind : "outcome" in e ? e.outcome : undefined])).toEqual([
      ["session.started", undefined],
      ["command.started", undefined],
      ["command.completed", "succeeded"],
      ["turn.started", undefined],
      ["user.message", undefined],
      ["tool.started", "think"],
      ["tool.completed", undefined],
      ["plan.updated", undefined],
      ["tool.started", "edit"],
      ["tool.started", "edit"],
      ["tool.completed", undefined],
      ["file.created", undefined],
      ["tool.failed", undefined],
      ["harness.notice", "error"],
      ["turn.completed", "failed"],
      ["context.compacted", undefined]
    ])
    expect(events.find((e) => e.type === "command.completed")).toMatchObject({ exitCode: 0, stdout: "README.md" })
    expect(events.find((e) => e.type === "user.message")).toMatchObject({
      content: [{ type: "text", text: "look at this" }, { type: "file", path: "/w/shot.png" }]
    })
    expect(events.find((e) => e.type === "plan.updated")).toMatchObject({
      entries: [{ content: "Edit", status: "in_progress" }, { content: "Test", status: "pending" }]
    })
    expect(events.find((e) => e.type === "harness.notice")).toMatchObject({ content: [{ type: "text", text: "Request timed out: Try again" }] })
    expect(events.find((e) => e.type === "context.compacted")).toMatchObject({ summary: "Summary of the work so far." })
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("reads exit codes only from the bash result trailer", () => {
    expect(bashStatus("boom\nexit status 2\nExit code 2\n\n<cwd>/w</cwd>", false, false)).toEqual({ outcome: "failed", exitCode: 2 })
    expect(bashStatus("boom\nExit code 2", false, false)).toEqual({ outcome: "failed", exitCode: 2 })
    expect(bashStatus("ok\n\n<cwd>/w</cwd>", false, false)).toEqual({ outcome: "succeeded" })
    expect(bashStatus("no output", false, false)).toEqual({ outcome: "succeeded" })
    expect(bashStatus("signal: killed\nCommand was aborted before completion\n\n<cwd>/w</cwd>", false, false)).toEqual({ outcome: "interrupted" })
    expect(bashStatus("Background shell started with ID: 3", false, true)).toEqual({ outcome: "unknown" })
    expect(bashStatus("Error: user cancelled assistant tool calling", true, false)).toEqual({ outcome: "interrupted" })
    expect(bashStatus("Permission denied", true, false)).toEqual({ outcome: "failed" })
  })
})
