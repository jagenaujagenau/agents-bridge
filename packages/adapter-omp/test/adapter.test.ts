import { Bridge, HostEnvironment } from "@agentbridge/core"
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
import { Effect, Path, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { classifyOmpFile, OmpAdapter, ompSessionRoots } from "../src/OmpAdapter.ts"
import { ompActivePath, ompCommandStatus, readTarget, resolveLeaf } from "../src/OmpNormalizer.ts"
import { OMP_CUSTOM_SESSION_ID, OMP_SESSION_ID, OMP_SUBAGENT_AGENT_ID } from "./generate-fixture.ts"

// Scenario IDs; the integrator moves these into @agentbridge/testing's `scenario`.
const omp = `omp:${OMP_SESSION_ID}`
const ompSubagent = `omp:${OMP_SESSION_ID}/${OMP_SUBAGENT_AGENT_ID}`
const ompCustom = `omp:${OMP_CUSTOM_SESSION_ID}`
const ompFixtureAgentDir = `${fixturesDir}omp/agent`

const layer = bridgeWithAdapter(OmpAdapter, OmpAdapter.layer, HostEnvironment.layer({ OMP_CODING_AGENT_DIR: ompFixtureAgentDir }))
const customLayer = bridgeWithAdapter(
  OmpAdapter,
  OmpAdapter.layer,
  HostEnvironment.layer({ OMP_CODING_AGENT_DIR: ompFixtureAgentDir, OMP_CODING_AGENT_SESSION_DIR: `${fixturesDir}omp/custom-sessions` })
)

adapterContract({ harness: "omp", layer, expectedSessions: [omp, ompSubagent], damagedSession: omp })

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

const events = (id: string) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    return yield* Stream.runCollect(bridge.sessions.events(id))
  })

describe("omp", () => {
  it.effect("golden files", () =>
    Effect.gen(function*() {
      expectGolden(golden("scenario"), yield* events(omp))
      expectGolden(golden("subagent"), yield* events(ompSubagent))
    }).pipe(Effect.provide(layer)))

  it.effect("the reference scenario", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(omp)
      expect(semanticProjection(session, yield* events(omp), { writes: "coarse" })).toEqual([
        ["user", "Add a Usage section to README.md and make sure the tests pass."],
        ["read", "README.md"],
        ["written", "README.md"],
        ["command", "npm test", "failed"],
        ["written", "docs/usage.md"],
        ["command", "npm test", "succeeded"],
        ["agent", "Added a Usage section to README.md and docs/usage.md. Tests pass."]
      ])
    }).pipe(Effect.provide(layer)))

  it.effect("session metadata, title slot and model roles", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(omp)
      expect(session).toMatchObject({
        title: "Add README usage section",
        projectPath: "/work/demo",
        startedAt: "2026-09-01T10:00:00.000Z",
        status: "unknown",
        // `smol` is a side-work role; the session's model is the default one.
        metadata: { model: "claude-sonnet-5" }
      })
      expect(session.relationships ?? []).toEqual([])
    }).pipe(Effect.provide(layer)))

  it.effect("notices, usage and exit codes", () =>
    Effect.gen(function*() {
      const all = yield* events(omp)
      expect(all.filter((e) => e.type === "harness.notice").map((e) => e.kind)).toEqual(["injected_context"])
      const usage = all.filter((e) => e.type === "usage.recorded")
      // Seven assistant responses plus the late cache warm-up, which hangs off the active branch.
      expect(usage).toHaveLength(8)
      expect(usage[0]).toMatchObject({ inputTokens: 12, cacheReadTokens: 30, outputTokens: 9, reasoningTokens: 5, model: "claude-sonnet-5" })
      expect(usage.at(-1)).toMatchObject({ inputTokens: 0, cacheReadTokens: 60, outputTokens: 1 })
      expect(all.filter((e) => e.type === "command.completed").map((e) => [e.outcome, e.exitCode]))
        .toEqual([["failed", 1], ["succeeded", undefined]])
      expect(all.find((e) => e.type === "tool.started" && e.name === "task")).toMatchObject({ kind: "other" })
      expect(all.find((e) => e.type === "file.changed")).toMatchObject({ path: "/work/demo/README.md", diff: expect.stringContaining("## Usage") })
    }).pipe(Effect.provide(layer)))

  it.effect("subagents are linked to the session that spawned them, not forks of it", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(ompSubagent)
      expect(session).toMatchObject({ parentSessionId: omp, agentLabel: OMP_SUBAGENT_AGENT_ID, metadata: { model: "claude-haiku-5" } })
      expect(session.relationships ?? []).toEqual([])
      expect(semanticProjection(session, yield* events(ompSubagent))).toEqual([
        ["user", "Find all TODO comments in src/."],
        ["agent", "There are no TODO comments in src/."]
      ])
    }).pipe(Effect.provide(layer)))
})

describe("omp custom session directory (OMP_CODING_AGENT_SESSION_DIR)", () => {
  it.effect("lists the flat directory alongside the agent directory", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const listed = yield* Stream.runCollect(bridge.sessions.list({ harness: "omp" }))
      expect(listed.map((d) => d.id).sort()).toEqual([omp, ompCustom, ompSubagent].sort())
    }).pipe(Effect.provide(customLayer)))

  it.effect("user commands, mentions, edits, plans and branches", () =>
    Effect.gen(function*() {
      const all = yield* events(ompCustom)
      expect(checkEventInvariants(all)).toEqual([])
      expect(all[0]?.type).toBe("session.started")
      expectGolden(golden("custom-dir"), all)
      const bridge = yield* Bridge
      const { session, warnings } = yield* bridge.sessions.get(ompCustom)
      expect(warnings).toEqual([])
      expect(session.title).toBe("Tidy the docs")

      // `!git status` and `$ print(1 / 0)`; the background `npm run dev` has not finished.
      const started = all.filter((e) => e.type === "command.started")
      expect(started.map((e) => [e.command, e.shell])).toEqual([["git status --short", undefined], ["print(1 / 0)", "python"], ["npm run dev", undefined]])
      expect(all.filter((e) => e.type === "command.completed").map((e) => [e.outcome, e.exitCode])).toEqual([["succeeded", 0], ["failed", 1]])

      const notices = all.flatMap((e) => (e.type === "harness.notice" ? [[e.kind, JSON.stringify(e.content)]] : []))
      expect(notices.map(([kind]) => kind)).toEqual(["injected_context", "other", "injected_context"])
      expect(notices[0]![1]).toContain("@docs/usage.md")
      expect(all.filter((e) => e.type === "user.message")).toHaveLength(1)

      expect(semanticProjection(session, all).filter((step) => step[0] !== "user" && step[0] !== "agent" && step[0] !== "command")).toEqual([
        ["changed", "docs/guide.md"],
        ["deleted", "docs/old.md"],
        ["created", "docs/new.md"],
        ["changed", "src/a.ts"],
        ["read", "src/a.ts"]
      ])
      expect(all.find((e) => e.type === "file.changed")).toMatchObject({ previousPath: "/work/demo/docs/usage.md" })
      expect(all.find((e) => e.type === "plan.updated")).toMatchObject({
        entries: [{ content: "Rename the guide", status: "completed" }, { content: "Drop old docs", status: "in_progress" }]
      })
      expect(all.find((e) => e.type === "tool.started" && e.name === "eval")).toMatchObject({ kind: "execute" })
      // The abandoned answer is off the active branch.
      expect(JSON.stringify(all)).not.toContain("abandoned answer")
      expect(all.filter((e) => e.type === "agent.reasoning")).toEqual([])
    }).pipe(Effect.provide(customLayer)))
})

describe("omp files and directories", () => {
  it("classifies sessions, subagents and nested subagents", () => {
    const stem = "2026-01-01T00-00-00-000Z_0190-ab"
    expect(classifyOmpFile(["-work", `${stem}.jsonl`], "/a")).toEqual({ path: "/a", nativeId: "0190-ab" })
    expect(classifyOmpFile(["-work", stem, "Anna.jsonl"], "/b"))
      .toEqual({ path: "/b", nativeId: "0190-ab/Anna", parentNativeId: "0190-ab", agentLabel: "Anna" })
    expect(classifyOmpFile(["-work", stem, "Anna", "Anna.Bob.jsonl"], "/c"))
      .toEqual({ path: "/c", nativeId: "0190-ab/Anna.Bob", parentNativeId: "0190-ab/Anna", agentLabel: "Bob" })
    expect(classifyOmpFile([`${stem}.jsonl`], "/d", true)).toEqual({ path: "/d", nativeId: "0190-ab" })
    expect(classifyOmpFile([stem, "Anna.jsonl"], "/e", true))
      .toEqual({ path: "/e", nativeId: "0190-ab/Anna", parentNativeId: "0190-ab", agentLabel: "Anna" })
    for (const skipped of ["__advisor.jsonl", "__advisor-2.jsonl", "Anna.bak.jsonl", "Anna.md", "Anna.json", "run.log"]) {
      expect(classifyOmpFile(["-work", stem, skipped], "/x")).toBeUndefined()
    }
    expect(classifyOmpFile(["-work", "notes", "x.jsonl"], "/y")).toBeUndefined()
  })

  it.effect("locates history like omp, without reading pi's shared overrides", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const roots = (env: Record<string, string>) => ompSessionRoots(path, "/h", env).roots
      expect(roots({})).toEqual(["/h/.omp/agent/sessions"])
      expect(roots({ PI_CODING_AGENT_DIR: "/pi", PI_CODING_AGENT_SESSION_DIR: "/pi-sessions" })).toEqual(["/h/.omp/agent/sessions"])
      expect(roots({ PI_CONFIG_DIR: ".myomp" })).toEqual(["/h/.myomp/agent/sessions"])
      expect(roots({ OMP_PROFILE: "work" })).toEqual(["/h/.omp/profiles/work/agent/sessions"])
      expect(roots({ PI_PROFILE: "work" })).toEqual(["/h/.omp/profiles/work/agent/sessions"])
      expect(roots({ OMP_PROFILE: "", PI_PROFILE: "work" })).toEqual(["/h/.omp/agent/sessions"])
      expect(roots({ XDG_DATA_HOME: "/x" })).toEqual(["/h/.omp/agent/sessions", "/x/omp/sessions"])
      expect(roots({ OMP_CODING_AGENT_DIR: "~/agent", XDG_DATA_HOME: "/x" })).toEqual(["/h/agent/sessions"])
      expect(ompSessionRoots(path, "/h", { OMP_CODING_AGENT_SESSION_DIR: "/s" })).toEqual({ roots: ["/h/.omp/agent/sessions", "/s"], flatDir: "/s" })
      expect(ompSessionRoots(path, "/h", { OMP_CODING_AGENT_SESSION_DIR: "~/.omp/agent/sessions" }))
        .toEqual({ roots: ["/h/.omp/agent/sessions"], flatDir: undefined })
    }).pipe(Effect.provide(NodeServices.layer)))

  it("strips read selectors and skips internal URLs", () => {
    expect(readTarget("src/a.ts:10-20")).toBe("src/a.ts")
    expect(readTarget("src/a.ts:raw:1-5")).toBe("src/a.ts")
    expect(readTarget("src/a.ts")).toBe("src/a.ts")
    expect(readTarget("artifact://3")).toBeUndefined()
    expect(readTarget("https://example.com/x")).toBeUndefined()
  })

  it("reads command outcomes from details first, then the trailer", () => {
    expect(ompCommandStatus({ text: "x\n\nCommand exited with code 2", failed: true, details: { exitCode: 2 } })).toEqual({ outcome: "failed", exitCode: 2 })
    expect(ompCommandStatus({ text: "ok", failed: false, details: {} })).toEqual({ outcome: "succeeded" })
    expect(ompCommandStatus({ text: "[Command timed out after 5 seconds]", failed: true, details: { timedOut: true } })).toEqual({ outcome: "interrupted" })
    expect(ompCommandStatus({ text: "Command aborted", failed: true, details: undefined })).toEqual({ outcome: "interrupted" })
    expect(ompCommandStatus({ text: "started", failed: false, details: { async: { state: "running" } } })).toBeUndefined()
  })
})

describe("omp branches", () => {
  const e = (id: string, parentId?: string, type = "message", activeLeafId?: string | null) =>
    ({ id, parentId, type, ...(activeLeafId !== undefined ? { activeLeafId } : {}) })

  it("resolves the leaf like omp's resolveSessionLeafId", () => {
    expect(resolveLeaf([])).toBeUndefined()
    expect(resolveLeaf([e("a"), e("b", "a")])).toBe("b")
    // Late usage restores the leaf it captured.
    expect(resolveLeaf([e("a"), e("b", "a"), e("u", "a", "model_usage", "b")])).toBe("b")
    // A captured leaf that no longer exists falls back to the newest self-selecting entry.
    expect(resolveLeaf([e("a"), e("b", "a"), e("u", "a", "model_usage", "gone")])).toBe("b")
    expect(resolveLeaf([e("a"), e("u", "a", "model_usage", null)])).toBeNull()
  })

  it("keeps the active branch, late usage hanging off it and title changes", () => {
    expect(ompActivePath([e("a"), e("b", "a"), e("u", "a", "model_usage", "b")])).toBeUndefined()
    const path = ompActivePath([e("a"), e("x", "a"), e("t", "x", "title_change"), e("b", "a"), e("u", "x", "model_usage", "b"), e("v", "b", "model_usage", "b")])
    expect([...path!].sort()).toEqual(["a", "b", "t", "v"])
    // No leaf: omp would show nothing; Bridge keeps the recorded work.
    expect(ompActivePath([e("a"), e("b", "a"), e("u", "a", "model_usage", null)])).toBeUndefined()
  })
})
