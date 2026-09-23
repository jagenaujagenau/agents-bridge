import { Bridge, HostEnvironment } from "@agentbridge/core"
import { NodeSqliteReader } from "@agentbridge/platform-node"
import { adapterContract, bridgeWithAdapter, expectGolden, openCodeFixtureDataDir, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { OpenCodeAdapter } from "../src/index.ts"

const layer = bridgeWithAdapter(
  OpenCodeAdapter,
  OpenCodeAdapter.layer,
  Layer.mergeAll(HostEnvironment.layer({ OPENCODE_DATA_DIR: openCodeFixtureDataDir }), NodeSqliteReader)
)

adapterContract({
  harness: "opencode",
  layer,
  expectedSessions: [scenario.opencode, scenario.opencodeSubagent],
  damagedSession: scenario.opencode
})

const golden = (name: string) => fileURLToPath(new URL(`./golden/${name}.jsonl`, import.meta.url))

describe("opencode", () => {
  it.effect("golden files", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expectGolden(golden("scenario"), yield* Stream.runCollect(bridge.sessions.events(scenario.opencode)))
      expectGolden(golden("subagent"), yield* Stream.runCollect(bridge.sessions.events(scenario.opencodeSubagent)))
    }).pipe(Effect.provide(layer)))

  it.effect("session rows become descriptors and sessions", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const descriptor = yield* bridge.sessions.describe(scenario.opencodeSubagent)
      expect(descriptor).toMatchObject({ parentSessionId: scenario.opencode, agentLabel: "explore", projectPath: "/work/demo" })
      expect(descriptor.sizeBytes).toBeUndefined()
      const { session } = yield* bridge.sessions.get(scenario.opencode)
      expect(session).toMatchObject({
        title: "Add README usage section",
        harness: { version: "1.18.23" },
        metadata: { model: "gpt-5.5", agent: "build" }
      })
    }).pipe(Effect.provide(layer)))

  it.effect("tool parts carry both call and outcome; exit codes come from metadata", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.sessions.events(scenario.opencode))
      const commands = events.filter((e) => e.type === "command.completed")
      expect(commands.map((e) => [e.outcome, e.exitCode, e.durationMs])).toEqual([["failed", 1, 120], ["succeeded", 0, 120]])
      expect(events.find((e) => e.type === "file.created")).toMatchObject({ path: "/work/demo/docs/usage.md" })
      expect(events.filter((e) => e.type === "harness.notice").map((e) => e.kind)).toEqual(["injected_context"])
    }).pipe(Effect.provide(layer)))

  it.effect("a missing database is an empty history, not an error", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expect(yield* Stream.runCollect(bridge.sessions.list())).toEqual([])
    }).pipe(
      Effect.provide(
        bridgeWithAdapter(OpenCodeAdapter, OpenCodeAdapter.layer, Layer.mergeAll(HostEnvironment.layer({ OPENCODE_DATA_DIR: "/nonexistent" }), NodeSqliteReader))
      )
    ))
})
