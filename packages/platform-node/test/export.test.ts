import { Bridge } from "@agentbridge/core"
import { BridgeSessionManifest, SessionEvent, validateEvent, validateSession } from "@agentbridge/schema"
import { fixtureBridgeOptions, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeBridge } from "../src/index.ts"

const layer = NodeBridge.layer(fixtureBridgeOptions)

describe("export (spec §55)", () => {
  it.effect.each([scenario.claude, scenario.codex])("%s exports a portable bundle", (id) =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const dir = mkdtempSync(join(tmpdir(), "bridge-export-"))
      try {
        const result = yield* bridge.sessions.export(id, dir)
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
        expect(Schema.decodeUnknownSync(BridgeSessionManifest)(manifest)).toEqual(result.manifest)
        expect(manifest).toMatchObject({ format: "bridge-session", version: 1, sessionId: id, warningCount: 2 })

        // Plain JSON parsing is enough to read the bundle; schemas only validate it.
        const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"))
        expect(validateSession(session).id).toBe(id)
        const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trimEnd().split("\n")
        expect(lines).toHaveLength(manifest.eventCount)
        const exported = lines.map((line) => validateEvent(JSON.parse(line)))
        const streamed = yield* Stream.runCollect(bridge.sessions.events(id))
        expect(exported.map((e) => Schema.encodeSync(SessionEvent)(e))).toEqual(
          streamed.map((e) => Schema.encodeSync(SessionEvent)(e))
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(layer)))

  it.effect("index stores the session and its ordered events", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const first = yield* bridge.sessions.index(scenario.codex)
      expect(first).toMatchObject({ skipped: false })
      expect(first.eventCount).toBeGreaterThan(0)
      const again = yield* bridge.sessions.index(scenario.codex)
      expect(again).toMatchObject({ skipped: true, eventCount: first.eventCount })
      expect((yield* bridge.sessions.index(scenario.codex, { force: true })).skipped).toBe(false)
    }).pipe(Effect.provide(layer)))
})
