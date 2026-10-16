import { Bridge, HostEnvironment, sequenceEvents, SqliteReader } from "@agentbridge/core"
import { NodeSqliteReader } from "@agentbridge/platform-node"
import { makeSessionId } from "@agentbridge/schema"
import {
  adapterContract,
  bridgeWithAdapter,
  checkEventInvariants,
  expectGolden,
  semanticProjection
} from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { decodeRow, FORMAT, initialState, normalize } from "../src/GooseNormalizer.ts"
import { GooseAdapter, gooseToolKind, shellStatus, sqliteTime, toolOutput } from "../src/index.ts"
import type { MessageRow } from "../src/schema/GooseRecord.ts"
import { GOOSE_HIDDEN, gooseFixtureRoot, gooseScenario as scenario } from "./generate-fixture.ts"

const root = gooseFixtureRoot()
const database = `${root}/data/sessions/sessions.db`

const layerWith = (reader: Layer.Layer<SqliteReader>, environment: Record<string, string> = { GOOSE_PATH_ROOT: root }) =>
  bridgeWithAdapter(GooseAdapter, GooseAdapter.layer, Layer.mergeAll(HostEnvironment.layer(environment), reader))

const layer = layerWith(NodeSqliteReader)

adapterContract({
  harness: "goose",
  layer,
  expectedSessions: [scenario.goose, scenario.gooseSubagent, scenario.gooseLegacy, scenario.gooseImported],
  damagedSession: scenario.goose
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

const reference = [
  ["user", "Add a Usage section to README.md and make sure the tests pass."],
  ["read", "README.md"],
  ["changed", "README.md"],
  ["command", "npm test", "failed"],
  ["created", "docs/usage.md"],
  ["command", "npm test", "succeeded"],
  ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
]

describe("goose golden files", () => {
  it.effect("scenario, subagent and legacy sessions", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.goose)))
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.gooseSubagent)))
      expectGolden(golden("legacy"), yield* Stream.runCollect(bridge.sessions.events(scenario.gooseLegacy)))
    }).pipe(Effect.provide(layer)))
})

describe("goose sessions database", () => {
  it.effect("produces the reference scenario", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.goose)
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.goose))
      expect(semanticProjection(session, events)).toEqual(reference)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:00.000Z",
        status: "unknown",
        metadata: { model: "claude-opus-5-20260815", provider: "anthropic", sessionType: "acp" }
      })
      expect(events.filter((e) => e.type === "user.message")).toHaveLength(1)
      expect(events.filter((e) => e.type === "harness.notice").map((e) => e.kind)).toEqual(["injected_context"])
      const commands = events.filter((e) => e.type === "command.completed")
      expect(commands).toMatchObject([
        { outcome: "failed", exitCode: 1, stdout: "1 failing: usage section missing example" },
        { outcome: "succeeded", exitCode: 0, stdout: "2 passing" }
      ])
      expect(events.find((e) => e.type === "command.started")).toMatchObject({ cwd: "/work/demo" })
      expect(events.filter((e) => e.type === "tool.started").map((e) => [e.name, e.kind])).toEqual([
        ["read", "read"],
        ["edit", "edit"],
        ["shell", "execute"],
        ["write", "edit"],
        ["shell", "execute"]
      ])
      expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => [e.type, e.certainty]))
        .toEqual([["turn.started", "known"], ["turn.completed", "inferred"]])
    }).pipe(Effect.provide(layer)))

  it.effect("usage is per model call, with cache reads and writes taken out of the input", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const usage = (yield* Stream.runCollect(bridge.sessions.events(scenario.goose))).filter((e) => e.type === "usage.recorded")
      expect(usage).toHaveLength(6)
      expect(usage[0]).toMatchObject({ model: "claude-opus-5-20260815", inputTokens: 200, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 80 })
    }).pipe(Effect.provide(layer)))

  it.effect("subagents link to their parent and unwrap the delegated task", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const descriptor = yield* bridge.sessions.describe(scenario.gooseSubagent)
      expect(descriptor).toMatchObject({ parentSessionId: scenario.goose, projectPath: "/work/demo", sourcePath: database })
      expect(descriptor.sizeBytes).toBeUndefined()
      const { session } = yield* bridge.sessions.get(scenario.gooseSubagent)
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.gooseSubagent))
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Find all TODO comments in src/."],
        ["command", "rg -n TODO src", "failed"],
        ["agent", "There are no TODO comments in src/."]
      ])
      expect(session.metadata).toMatchObject({ sessionType: "sub_agent" })
    }).pipe(Effect.provide(layer)))

  it.effect("hidden internal sessions are resolvable but not listed", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const listed = (yield* Stream.runCollect(bridge.sessions.list())).map((d) => d.id)
      expect(listed).not.toContain(makeSessionId("goose", GOOSE_HIDDEN))
      const { session } = yield* bridge.sessions.get(makeSessionId("goose", GOOSE_HIDDEN))
      expect(session.metadata).toMatchObject({ sessionType: "hidden" })
    }).pipe(Effect.provide(layer)))

  it.effect("listing honours since and projectPath", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const since = (yield* Stream.runCollect(bridge.sessions.list({ since: new Date("2026-09-01T10:00:20Z") }))).map((d) => d.id)
      // Database sessions by `updated_at`; legacy files by modification time.
      expect(since).toContain(scenario.gooseSubagent)
      expect(since).not.toContain(scenario.goose)
      expect(since).not.toContain(scenario.gooseImported)
      const project = (yield* Stream.runCollect(bridge.sessions.list({ projectPath: "/work/legacy" }))).map((d) => d.id)
      expect(project).toEqual([scenario.gooseLegacy])
    }).pipe(Effect.provide(layer)))

  it.effect("never queries credential-bearing columns or tables", () =>
    Effect.gen(function*() {
      const queries: Array<string> = []
      const spy = Layer.effect(
        SqliteReader,
        Effect.gen(function*() {
          const inner = yield* SqliteReader
          return { rows: (db, sql, params) => (queries.push(sql), inner.rows(db, sql, params)) }
        })
      ).pipe(Layer.provide(NodeSqliteReader))
      yield* Effect.gen(function*() {
        const bridge = yield* Bridge
        for (const d of yield* Stream.runCollect(bridge.sessions.list())) yield* Stream.runDrain(bridge.sessions.events(d.id))
      }).pipe(Effect.provide(layerWith(spy)))
      expect(queries.length).toBeGreaterThan(0)
      for (const sql of queries) {
        expect(sql).not.toMatch(/\*|extension_data|model_config|recipe|usage_ledger|secret|system_prompt/)
      }
    }))
})

describe("goose legacy JSONL sessions", () => {
  it.effect("are read when Goose never imported them, and listed once when it did", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const legacy = yield* bridge.sessions.describe(scenario.gooseLegacy)
      expect(legacy).toMatchObject({ sourcePath: `${root}/data/sessions/20250611_090000.jsonl`, projectPath: "/work/legacy", startedAt: "2025-06-11T09:00:00.000Z" })
      expect(legacy.sizeBytes).toBeGreaterThan(0)
      const imported = yield* bridge.sessions.describe(scenario.gooseImported)
      expect(imported.sourcePath).toBe(database)
      const listed = (yield* Stream.runCollect(bridge.sessions.list())).filter((d) => d.id === scenario.gooseImported)
      expect(listed).toHaveLength(1)
    }).pipe(Effect.provide(layer)))

  it.effect("developer MCP tools: view is a read; the shell recorded no exit status", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.gooseLegacy)
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.gooseLegacy))
      expect(session.title).toBe("Check the build")
      expect(semanticProjection(session, events)).toEqual([
        ["user", "Run the build and show me the README."],
        ["agent", "Let me look at the README."],
        ["read", "README.md"],
        ["command", "npm run build", "unknown"],
        ["agent", "The build succeeded."]
      ])
      // Blocks addressed only to the user are UI duplicates of the model-facing output.
      expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ output: "```\n1: # Legacy\n```" })
      expect(events.find((e) => e.type === "command.completed")?.exitCode).toBeUndefined()
      expect(events.some((e) => e.type === "usage.recorded")).toBe(false)
    }).pipe(Effect.provide(layer)))
})

describe("goose locations", () => {
  it.effect("a missing database is an empty history, not an error", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expect(yield* Stream.runCollect(bridge.sessions.list())).toEqual([])
    }).pipe(Effect.provide(layerWith(NodeSqliteReader, { GOOSE_PATH_ROOT: "/nonexistent" }))))

  it.effect("a relative GOOSE_PATH_ROOT is ignored, as Goose ignores it", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const [detected] = yield* bridge.harnesses.detect
      expect(detected).toMatchObject({ harness: "goose", historyAvailable: false })
    }).pipe(Effect.provide(layerWith(NodeSqliteReader, { GOOSE_PATH_ROOT: "fixtures/goose", HOME: "/nonexistent", PATH: "" }))))

  it.effect("detection finds the database under GOOSE_PATH_ROOT/data", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const [detected] = yield* bridge.harnesses.detect
      expect(detected).toMatchObject({ harness: "goose", historyAvailable: true, paths: [database] })
    }).pipe(Effect.provide(layerWith(NodeSqliteReader, { GOOSE_PATH_ROOT: root, HOME: "/nonexistent", PATH: "" }))))
})

describe("goose records beyond the scenario", () => {
  const sessionId = makeSessionId("goose", "t")
  let id = 0
  const row = (role: string, content: unknown, metadata?: object, created = 1756720800): MessageRow => ({
    id: ++id,
    message_id: `m${id}`,
    role,
    content_json: JSON.stringify(content),
    created_timestamp: created,
    metadata_json: metadata === undefined ? null : JSON.stringify(metadata)
  })
  const run = (rows: ReadonlyArray<MessageRow>) =>
    Effect.runSync(
      Stream.fromIterable(rows.map((r, i) => decodeRow(r, i))).pipe(
        Stream.mapAccum(() => initialState(sessionId, "/t.db", FORMAT, "/w"), normalize),
        sequenceEvents(sessionId),
        Stream.runCollect
      )
    )
  const call = (callId: string, name: string, args: object) => ({ type: "toolRequest", id: callId, toolCall: { status: "success", value: { name, arguments: args } } })
  const response = (callId: string, value: unknown) => ({ type: "toolResponse", id: callId, toolResult: { status: "success", value } })

  it("compaction copies, continuations, steers, notifications and invalid calls", () => {
    const events = run([
      row("user", [{ type: "text", text: "first" }], { userVisible: true, agentVisible: false }),
      row("user", [{ type: "text", text: "Summary of the work so far" }], { userVisible: false, agentVisible: true }),
      row("assistant", [{ type: "text", text: "The previous message contains a summary." }], { userVisible: false, agentVisible: true }),
      row("user", [{ type: "text", text: "also check the docs" }], { userVisible: true, agentVisible: true, steer: true }),
      row("assistant", [{ type: "toolRequest", id: "bad", toolCall: { status: "error", error: "Could not parse tool call" } }]),
      row("user", [response("bad", [{ type: "text", text: "error" }])]),
      row("assistant", [{ type: "systemNotification", notificationType: "inlineMessage", msg: "Compacting…" }], { userVisible: true, agentVisible: false }),
      row("assistant", [{ type: "error", kind: "contextLengthExceeded", message: "Context limit reached" }], { userVisible: true, agentVisible: false }),
      row("user", [{ type: "text", text: "second" }])
    ])
    expect(events.map((e) => [e.type, "kind" in e ? e.kind : "outcome" in e ? e.outcome : undefined])).toEqual([
      ["session.started", undefined],
      ["turn.started", undefined],
      ["user.message", undefined],
      ["harness.notice", "injected_context"],
      ["harness.notice", "injected_context"],
      ["user.message", undefined],
      ["harness.notice", "error"],
      ["harness.notice", "other"],
      ["harness.notice", "error"],
      ["turn.completed", "failed"],
      ["turn.started", undefined],
      ["user.message", undefined]
    ])
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("legacy text editor diffs, writes and directory views", () => {
    const events = run([
      row("user", [{ type: "text", text: "go" }]),
      row("assistant", [
        call("d", "developer__text_editor", { command: "str_replace", path: "/w", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-x\n+y\n" }),
        call("w", "developer__text_editor", { command: "write", path: "new.md", file_text: "x" }),
        call("v", "developer__text_editor", { command: "view", path: "/w/src" }),
        call("i", "read_image", { path: "/w/shot.png" })
      ]),
      row("user", [
        response("d", [{ type: "text", text: "Successfully applied diff" }]),
        response("w", [{ type: "text", text: "Successfully wrote to /w/new.md" }]),
        response("v", [{ type: "text", text: "'/w/src' is a directory. Contents:\n\n  a.ts\n" }]),
        response("i", { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false })
      ])
    ])
    expect(events.filter((e) => e.type.startsWith("file.")).map((e) => [e.type, (e as { path: string }).path, e.certainty])).toEqual([
      ["file.changed", "/w/src/a.ts", "known"],
      ["file.changed", "/w/new.md", "inferred"],
      ["file.read", "/w/shot.png", "known"]
    ])
    expect(gooseToolKind("developer__text_editor", { command: "view" })).toBe("read")
    expect(checkEventInvariants(events)).toEqual([])
  })

  it("reads exit codes only where Goose recorded them", () => {
    const ok = (texts: Array<string>, extra: object = {}) => toolOutput({ status: "success", value: { content: texts.map((text) => ({ type: "text", text })), ...extra } })
    expect(shellStatus("shell", ok(["exit code: 2", "boom"], { isError: true }))).toEqual({ outcome: "failed", exitCode: 2, stdout: "boom" })
    expect(shellStatus("shell", ok(["out\n\nCommand exited with code 3"], { isError: true }))).toEqual({ outcome: "failed", exitCode: 3, stdout: "out" })
    expect(shellStatus("shell", ok(["partial\n\nCommand timed out after 60 seconds"], { isError: true, structuredContent: { stdout: "partial", stderr: "", timed_out: true } })))
      .toMatchObject({ outcome: "interrupted" })
    expect(shellStatus("developer__shell", toolOutput({ status: "success", value: [{ type: "text", text: "done" }] }))).toEqual({ outcome: "unknown", stdout: "done" })
    expect(shellStatus("developer__shell", toolOutput({ status: "error", error: "Shell command was cancelled by user" }))).toMatchObject({ outcome: "interrupted" })
    expect(shellStatus("shell", toolOutput({ status: "error", error: "-32603: boom" }))).toMatchObject({ outcome: "failed" })
  })

  it("parses SQLite timestamps as UTC", () => {
    expect(sqliteTime("2026-09-01 10:00:13")).toBe("2026-09-01T10:00:13.000Z")
    expect(sqliteTime("2025-05-20T08:00:00+02:00")).toBe("2025-05-20T06:00:00.000Z")
    expect(sqliteTime(1756720800)).toBe("2025-09-01T10:00:00.000Z")
    expect(sqliteTime(1756720800123)).toBe("2025-09-01T10:00:00.123Z")
    expect(sqliteTime("not a date")).toBeUndefined()
  })
})
