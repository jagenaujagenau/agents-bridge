import { Bridge, HostEnvironment } from "@agentbridge/core"
import { adapterContract, bridgeWithAdapter, cursorFixtureDir, expectGolden, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { classifyCursorFile, CursorAdapter, decodeCursorProjectDir, parseCursorTimestamp, splitUserText } from "../src/index.ts"

const layer = bridgeWithAdapter(CursorAdapter, CursorAdapter.layer, HostEnvironment.layer({ CURSOR_CONFIG_DIR: cursorFixtureDir }))

adapterContract({ harness: "cursor", layer, expectedSessions: [scenario.cursor, scenario.cursorSubagent], damagedSession: scenario.cursor })

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("cursor", () => {
  it.effect("golden files", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.cursor)))
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.cursorSubagent)))
    }).pipe(Effect.provide(layer)))

  it.effect("tool effects without recorded results are inferred, and commands never complete", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.cursor)
      expect(session.capabilities.toolResults).toBe(false)
      expect(session).toMatchObject({ projectPath: "/work/demo", startedAt: "2026-09-01T10:00:00.000Z" })
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.cursor))
      expect(events.some((e) => e.type === "tool.completed" || e.type === "command.completed")).toBe(false)
      const effects = events.filter((e) => e.type.startsWith("file."))
      expect(effects.map((e) => [e.type, e.certainty])).toEqual([
        ["file.read", "inferred"],
        ["file.changed", "inferred"],
        ["file.created", "inferred"]
      ])
      expect(events.filter((e) => e.type === "harness.notice").map((e) => e.kind)).toEqual(["injected_context"])
    }).pipe(Effect.provide(layer)))

  it.effect("subagent transcripts link to their parent; failed turns become error notices", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const { session } = yield* bridge.sessions.get(scenario.cursorSubagent)
      expect(session.parentSessionId).toBe(scenario.cursor)
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.cursorSubagent))
      expect(events.slice(-2)).toMatchObject([{ type: "harness.notice", kind: "error" }, { type: "turn.completed", outcome: "failed" }])
    }).pipe(Effect.provide(layer)))

  it("parses Cursor's user turn wrapper and local timestamps", () => {
    expect(parseCursorTimestamp("Saturday, June 14, 2026, 3:42 PM (UTC+2)")).toBe("2026-06-14T13:42:00.000Z")
    expect(parseCursorTimestamp("Monday, Jan 5, 2026, 12:05 AM (UTC-5:30)")).toBe("2026-01-05T05:35:00.000Z")
    const split = splitUserText("<external_links>x</external_links>\n<user_query>\nfix it\n</user_query>")
    expect(split).toMatchObject({ prompt: "fix it", context: ["<external_links>x</external_links>"] })
    expect(splitUserText("plain prompt").prompt).toBe("plain prompt")
    expect(classifyCursorFile(["p", "agent-transcripts", "x", "x.jsonl"], "/a")?.nativeId).toBe("x")
    expect(classifyCursorFile(["p", "agent-transcripts", "x", "subagents", "y.jsonl"], "/a")).toMatchObject({ nativeId: "x/y", parentNativeId: "x" })
    expect(classifyCursorFile(["p", "terminals", "1.txt"], "/a")).toBeUndefined()
  })

  it.effect("decodes ambiguous project directory names against the filesystem", () =>
    Effect.gen(function*() {
      const dirs = new Set(["/Users", "/Users/me", "/Users/me/my-app", "/Users/me/site.com", "/Users/me/my", "/Users/me/my/app-x"])
      const exists = (path: string) => Effect.succeed(dirs.has(path))
      expect(yield* decodeCursorProjectDir("Users-me-my-app", exists)).toBe("/Users/me/my-app")
      expect(yield* decodeCursorProjectDir("Users-me-site-com", exists)).toBe("/Users/me/site.com")
      expect(yield* decodeCursorProjectDir("Users-me-my-app-x", exists)).toBe("/Users/me/my/app-x")
      expect(yield* decodeCursorProjectDir("Users-gone-away", exists)).toBeUndefined()
    }))
})
