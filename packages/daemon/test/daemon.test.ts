import { Bridge, gitEnricher } from "@agentbridge/core"
import { NodeBridge } from "@agentbridge/platform-node"
import { encodeEventLine } from "@agentbridge/schema"
import { adapterContract, claudeFixtureDir, fixtureBridgeOptions, scenario } from "@agentbridge/testing"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpClient } from "effect/unstable/http"
import { DaemonBridge, type Health, routes, serveDaemon, socketClient } from "../src/index.ts"

let sockets = 0
const socketPath = () => join(mkdtempSync(join(tmpdir(), "bridge-d-")), `d${sockets++}.sock`)

/** A daemon serving `embedded` on a fresh socket, and a `Bridge` client connected to it. */
const viaDaemon = (embedded: Layer.Layer<Bridge, unknown>, socket = socketPath()) => {
  const server = Layer.effectDiscard(serveDaemon({ socket })).pipe(Layer.provide(embedded))
  return DaemonBridge.layer({ socket }).pipe(Layer.provide(server), Layer.provide(NodeServices.layer), Layer.orDie)
}

const embedded = NodeBridge.layer(fixtureBridgeOptions)
const remote = viaDaemon(embedded)

// Spec §71: the daemon is an alternative backend with equivalent domain behavior.
adapterContract({ harness: "claude-code", layer: remote, expectedSessions: [scenario.claude, scenario.claudeSubagent], damagedSession: scenario.claude })
adapterContract({ harness: "opencode", layer: remote, expectedSessions: [scenario.opencode, scenario.opencodeSubagent], damagedSession: scenario.opencode })

const collect = (id: string, options?: Parameters<Bridge["Service"]["sessions"]["events"]>[1]) =>
  Effect.flatMap(Effect.service(Bridge), (bridge) => Stream.runCollect(bridge.sessions.events(id, options)))

describe("daemon backend", () => {
  it.effect("returns exactly what the embedded backend returns", () =>
    Effect.gen(function*() {
      for (const id of Object.values(scenario)) {
        const local = yield* collect(id, { enrichers: [gitEnricher], redact: true }).pipe(Effect.provide(embedded))
        const viaSocket = yield* collect(id, { enrichers: [gitEnricher], redact: true }).pipe(Effect.provide(remote))
        expect(viaSocket.map((e) => encodeEventLine(e)), id).toEqual(local.map((e) => encodeEventLine(e)))
      }
    }))

  it.effect("errors keep their type across the socket", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      expect((yield* Effect.flip(bridge.sessions.get("claude-code:missing")))._tag).toBe("SessionNotFound")
      expect((yield* Effect.flip(Stream.runCollect(bridge.sessions.events("nope:x"))))._tag).toBe("AdapterUnavailable")
      expect((yield* Effect.flip(bridge.sessions.export(scenario.claude, "/proc/definitely/not/writable")))._tag).toBe("ExportError")
    }).pipe(Effect.provide(remote)))

  it.effect("an unreachable daemon is BackendUnavailable", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Effect.flatMap(Effect.service(Bridge), (b) => b.sessions.get(scenario.claude)).pipe(
        Effect.provide(DaemonBridge.layer({ socket: join(tmpdir(), "no-such-bridge.sock") }).pipe(Layer.provide(NodeServices.layer)))
      ))
      expect(error._tag).toBe("BackendUnavailable")
    }))

  it.live("watchers of one session share a single tail and each get the full stream", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-dw-"))
    cpSync(claudeFixtureDir, home, { recursive: true })
    const file = join(home, "projects", "-work-demo", "11111111-1111-4111-8111-111111111111.jsonl")
    const socket = socketPath()
    const layer = viaDaemon(NodeBridge.layer({ adapters: ["claude-code"], probeVersions: false, environment: { CLAUDE_CONFIG_DIR: home } }), socket)
    const health = Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(`http://bridge.daemon${routes.health}`)
      return (yield* response.json) as unknown as Health
    }).pipe(Effect.scoped, Effect.provide(socketClient(socket)))
    return Effect.gen(function*() {
      const bridge = yield* Bridge
      const initial = (yield* Stream.runCollect(bridge.sessions.events(scenario.claude))).length
      const watch = Stream.runCollect(Stream.take(bridge.sessions.watch(scenario.claude, { interval: "20 millis" }), initial + 1))
      const first = yield* Effect.forkChild(watch)
      yield* Effect.sleep("150 millis")
      // Joins after the tail started: still receives every existing event.
      const second = yield* Effect.forkChild(watch)
      yield* Effect.sleep("150 millis")
      const record = JSON.parse(readFileSync(file, "utf8").split("\n").find((l) => l.includes("\"c-a7\""))!)
      appendFileSync(file, JSON.stringify({ ...record, uuid: "c-a8", message: { ...record.message, id: "msg_7", content: [{ type: "text", text: "Shared." }] } }) + "\n")
      const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)]
      expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id))
      expect(a.at(-1)).toMatchObject({ type: "agent.message", content: [{ type: "text", text: "Shared." }] })
      // Both clients stopped reading; the daemon must release their subscriptions.
      yield* Effect.sleep("300 millis")
      expect((yield* health).watches).toBe(0)
    }).pipe(Effect.provide(layer), Effect.timeout("15 seconds"), Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))))
  })
})
