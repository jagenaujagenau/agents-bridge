import { Bridge } from "@agentbridge/core"
import { claudeFixtureDir, piFixtureAgentDir, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeBridge } from "../src/index.ts"

/** A private copy of a fixture tree, so tests can append to live sources. */
const copy = (from: string) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-watch-"))
  cpSync(from, dir, { recursive: true })
  return dir
}

const claudeFile = (home: string) => join(home, "projects", "-work-demo", "11111111-1111-4111-8111-111111111111.jsonl")

const extraClaudeLine = (file: string) => {
  const record = JSON.parse(readFileSync(file, "utf8").split("\n").find((l) => l.includes("\"c-a7\""))!)
  return JSON.stringify({ ...record, uuid: "c-a8", parentUuid: "c-a7", message: { ...record.message, id: "msg_7", content: [{ type: "text", text: "One more thing." }] } }) + "\n"
}

describe("watch", () => {
  it.live("tails an append-only source from its last offset, including lines written in pieces", () => {
    const home = copy(claudeFixtureDir)
    const file = claudeFile(home)
    const layer = NodeBridge.layer({ adapters: ["claude-code"], probeVersions: false, environment: { CLAUDE_CONFIG_DIR: home } })
    return Effect.gen(function*() {
      const bridge = yield* Bridge
      const initial = (yield* Stream.runCollect(bridge.sessions.events(scenario.claude))).length
      const watcher = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(bridge.sessions.watch(scenario.claude, { interval: "20 millis" }), initial + 1))
      )
      yield* Effect.sleep("100 millis")
      const line = extraClaudeLine(file)
      // A writer flushes half a line, then the rest: nothing is emitted until the newline arrives.
      appendFileSync(file, line.slice(0, 40))
      yield* Effect.sleep("100 millis")
      appendFileSync(file, line.slice(40))
      const events = yield* Fiber.join(watcher)
      expect(events.map((e) => e.sequence)).toEqual([...Array(initial + 1).keys()])
      expect(events.at(-1)).toMatchObject({ type: "agent.message", content: [{ type: "text", text: "One more thing." }] })
    }).pipe(Effect.provide(layer), Effect.timeout("10 seconds"), Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))))
  })

  it.live("fails when a followed source is rewritten instead of appended to", () => {
    const home = copy(claudeFixtureDir)
    const layer = NodeBridge.layer({ adapters: ["claude-code"], probeVersions: false, environment: { CLAUDE_CONFIG_DIR: home } })
    return Effect.gen(function*() {
      const bridge = yield* Bridge
      const watcher = yield* Effect.forkChild(Stream.runDrain(bridge.sessions.watch(scenario.claude, { interval: "20 millis" })))
      yield* Effect.sleep("100 millis")
      writeFileSync(claudeFile(home), "{}\n")
      const exit = yield* Fiber.await(watcher)
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("rewritten")
    }).pipe(Effect.provide(layer), Effect.timeout("10 seconds"), Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))))
  })

  it.live("re-reads sources that cannot be tailed", () => {
    const home = copy(piFixtureAgentDir)
    const file = join(home, "sessions", "--work-demo--", "2026-09-01T10-00-00-000Z_55555555-5555-4555-8555-555555555555.jsonl")
    const layer = NodeBridge.layer({ adapters: ["pi"], probeVersions: false, environment: { PI_CODING_AGENT_DIR: home } })
    return Effect.gen(function*() {
      const bridge = yield* Bridge
      const initial = (yield* Stream.runCollect(bridge.sessions.events(scenario.pi))).length
      const watcher = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(bridge.sessions.watch(scenario.pi, { interval: "20 millis" }), initial + 2))
      )
      yield* Effect.sleep("100 millis")
      const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!)
      appendFileSync(file, JSON.stringify({ type: "message", id: "e9999999", parentId: last.id, timestamp: "2026-09-01T10:00:15.000Z", message: { role: "user", content: [{ type: "text", text: "And one more." }] } }) + "\n")
      const events = yield* Fiber.join(watcher)
      expect(events.slice(-2).map((e) => e.type)).toEqual(["turn.started", "user.message"])
      expect(events.at(-1)).toMatchObject({ content: [{ type: "text", text: "And one more." }] })
    }).pipe(Effect.provide(layer), Effect.timeout("10 seconds"), Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))))
  })
})
