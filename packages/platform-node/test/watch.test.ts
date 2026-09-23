import { Bridge } from "@agentbridge/core"
import { claudeFixtureDir, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeBridge } from "../src/index.ts"

describe("watch", () => {
  it.live("emits existing events, then events appended to the source", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-watch-"))
    cpSync(claudeFixtureDir, home, { recursive: true })
    const file = join(home, "projects", "-work-demo", "11111111-1111-4111-8111-111111111111.jsonl")
    const layer = NodeBridge.layer({ adapters: ["claude-code"], probeVersions: false, environment: { CLAUDE_CONFIG_DIR: home } })
    return Effect.gen(function*() {
      const bridge = yield* Bridge
      const initial = (yield* Stream.runCollect(bridge.sessions.events(scenario.claude))).length
      const watcher = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(bridge.sessions.watch(scenario.claude, { interval: "20 millis" }), initial + 1))
      )
      yield* Effect.sleep("100 millis")
      const record = JSON.parse(readFileSync(file, "utf8").split("\n").find((l) => l.includes("\"c-a7\""))!)
      appendFileSync(file, JSON.stringify({ ...record, uuid: "c-a8", parentUuid: "c-a7", message: { ...record.message, id: "msg_7", content: [{ type: "text", text: "One more thing." }] } }) + "\n")
      const events = yield* Fiber.join(watcher)
      expect(events.map((e) => e.sequence)).toEqual([...Array(initial + 1).keys()])
      expect(events.at(-1)).toMatchObject({ type: "agent.message", content: [{ type: "text", text: "One more thing." }] })
    }).pipe(Effect.provide(layer), Effect.timeout("10 seconds"), Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))))
  })
})
