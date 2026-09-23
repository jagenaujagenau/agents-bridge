import { Bridge, type Emission, HarnessRegistry, type HarnessAdapterShape, SessionReadError, SessionStore, sessionCapabilities } from "@agentbridge/core"
import { HarnessId, makeSessionId, noCapabilities, type SessionDescriptor, type SessionEvent } from "@agentbridge/schema"
import { MemorySessionStore } from "@agentbridge/store-memory"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const harness = Schema.decodeUnknownSync(HarnessId)("test")
const descriptor: SessionDescriptor = { id: makeSessionId(harness, "s"), harness, nativeId: "s", sourcePath: "virtual" }
const revisions = (revision: number): Stream.Stream<Emission> => Stream.make(
  { _tag: "Metadata", patch: { title: { value: `revision ${revision}`, priority: 1 } } },
  { _tag: "Event", event: { id: `evt_${revision}` as SessionEvent["id"], type: "agent.message", certainty: "known", content: [{ type: "text", text: `revision ${revision}` }], source: { provider: "test", format: "test" } } }
)
const testLayer = (read: HarnessAdapterShape["read"]) => {
  const adapter: HarnessAdapterShape = { id: harness, name: "Test", capabilities: noCapabilities, resolve: () => Effect.succeed(descriptor), listSessions: () => Stream.succeed(descriptor), detect: Effect.succeed({ harness, name: "Test", installed: false, historyAvailable: true, paths: [], notes: [] }), read }
  return Bridge.layer.pipe(
    Layer.provideMerge(MemorySessionStore.layer),
    Layer.provide(HarnessRegistry.fromAdapters([adapter])),
    Layer.provide(NodeServices.layer)
  )
}

describe("single-pass, staged imports", () => {
  it.effect("exports metadata and events from the same read", () => {
    let reads = 0
    return Effect.gen(function*() {
      const b = yield* Bridge
      const root = mkdtempSync(join(tmpdir(), "bridge-snapshot-"))
      try {
        const dir = join(root, "bundle")
        yield* b.sessions.export(descriptor.id, dir)
        expect(reads).toBe(1)
        expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).title).toBe("revision 1")
        expect(JSON.parse(readFileSync(join(dir, "events.jsonl"), "utf8")).content[0].text).toBe("revision 1")
        expect(readdirSync(root)).toEqual(["bundle"])
      } finally { rmSync(root, { recursive: true, force: true }) }
    }).pipe(Effect.provide(testLayer(() => Stream.suspend(() => revisions(++reads)))))
  })

  it.effect("indexes one read and verifies stored events, not just returned metadata", () => {
    let reads = 0
    return Effect.gen(function*() {
      const b = yield* Bridge
      const store = yield* SessionStore
      const loaded = yield* b.sessions.index(descriptor.id)
      expect(reads).toBe(1)
      expect(Option.getOrUndefined(yield* store.getSession(descriptor.id))).toEqual(loaded.session)
      const events = yield* Stream.runCollect(store.events(descriptor.id))
      expect(events).toHaveLength(loaded.eventCount)
      expect(events[0]).toMatchObject({ sequence: 0, content: [{ text: loaded.session.title }] })
    }).pipe(Effect.provide(testLayer(() => Stream.suspend(() => revisions(++reads)))))
  })

  it.effect("does not publish a partial bundle on a source failure", () =>
    Effect.gen(function*() {
      const b = yield* Bridge
      const root = mkdtempSync(join(tmpdir(), "bridge-failed-export-"))
      try {
        const dir = join(root, "bundle")
        yield* Effect.flip(b.sessions.export(descriptor.id, dir))
        expect(existsSync(dir)).toBe(false)
        expect(readdirSync(root)).toEqual([])
      } finally { rmSync(root, { recursive: true, force: true }) }
    }).pipe(Effect.provide(testLayer(() => Stream.concat(revisions(1), Stream.fail(new SessionReadError({ harness, path: "virtual", message: "unreadable" })))))))

  it.effect("refuses to overwrite a nonempty destination", () =>
    Effect.gen(function*() {
      const b = yield* Bridge
      const dir = mkdtempSync(join(tmpdir(), "bridge-existing-export-"))
      try {
        writeFileSync(join(dir, "events.jsonl"), "existing data")
        const error = yield* Effect.flip(b.sessions.export(descriptor.id, dir))
        expect(error._tag).toBe("ExportError")
        expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe("existing data")
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }).pipe(Effect.provide(testLayer(() => revisions(1)))))
})
