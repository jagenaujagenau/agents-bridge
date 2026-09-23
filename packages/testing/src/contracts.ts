import { Bridge, SessionStore } from "@agentbridge/core"
import { encodeEventLine, type Session, type SessionEvent, type SessionId } from "@agentbridge/schema"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { checkEventInvariants, CREDENTIAL_PATTERNS } from "./invariants.ts"

export interface AdapterContractOptions {
  readonly harness: string
  /** A Bridge wired to this adapter over sanitized fixtures. */
  readonly layer: Layer.Layer<Bridge>
  /** Sessions the fixtures must expose. */
  readonly expectedSessions: ReadonlyArray<string>
  /** A session whose source contains one malformed line and one unknown record type. */
  readonly damagedSession: string
  /** Warning codes the damaged session must report. Defaults to malformed_json + unknown_record_type. */
  readonly damagedWarnings?: ReadonlyArray<string>
}

/** Shared expectations for every harness adapter (spec §65). */
export const adapterContract = (options: AdapterContractOptions) =>
  describe(`adapter contract: ${options.harness}`, () => {
    const collect = (id: string) =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        return yield* Stream.runCollect(bridge.sessions.events(id))
      })

    it.effect("discovers exactly the expected sessions", () =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        const listed = yield* Stream.runCollect(bridge.sessions.list({ harness: options.harness }))
        expect(listed.map((d) => d.id).sort()).toEqual([...options.expectedSessions].sort())
        for (const descriptor of listed) expect(descriptor.harness).toBe(options.harness)
      }).pipe(Effect.provide(options.layer)))

    it.effect("session and event IDs are stable across imports", () =>
      Effect.gen(function*() {
        for (const id of options.expectedSessions) {
          const first = yield* collect(id)
          const second = yield* collect(id)
          expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id))
          expect(second.map((e) => encodeEventLine(e))).toEqual(first.map((e) => encodeEventLine(e)))
        }
      }).pipe(Effect.provide(options.layer)))

    it.effect("streams valid canonical events with sound structure", () =>
      Effect.gen(function*() {
        for (const id of options.expectedSessions) {
          const events = yield* collect(id)
          expect(events.length).toBeGreaterThan(0)
          expect(checkEventInvariants(events)).toEqual([])
          for (const event of events) expect(event.sessionId).toBe(id)
        }
      }).pipe(Effect.provide(options.layer)))

    it.effect("records correct source metadata", () =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        for (const id of options.expectedSessions) {
          const descriptor = yield* bridge.sessions.describe(id)
          const events = yield* collect(id)
          for (const event of events) {
            expect(event.source.provider).toBe(options.harness)
            expect(event.source.path).toBe(descriptor.sourcePath)
            expect(event.source.recordIndex).toBeTypeOf("number")
          }
        }
      }).pipe(Effect.provide(options.layer)))

    it.effect("loads sessions with metadata and never fabricates an end", () =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        for (const id of options.expectedSessions) {
          const loaded = yield* bridge.sessions.get(id)
          expect(loaded.session.id).toBe(id)
          expect(loaded.session.harness.id).toBe(options.harness)
          expect(loaded.session.status).toBe("unknown")
          expect(loaded.eventCount).toBe((yield* collect(id)).length)
          const events = yield* collect(id)
          expect(events.some((e) => e.type === "session.completed")).toBe(false)
        }
      }).pipe(Effect.provide(options.layer)))

    it.effect("keeps damaged sessions readable and reports warnings once per kind", () =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        const loaded = yield* bridge.sessions.get(options.damagedSession)
        const codes = loaded.warnings.map((w) => w.code).sort()
        expect(codes).toEqual([...(options.damagedWarnings ?? ["malformed_json", "unknown_record_type"])].sort())
        expect(loaded.eventCount).toBeGreaterThan(5)
      }).pipe(Effect.provide(options.layer)))

    it.effect("exposes no credentials", () =>
      Effect.gen(function*() {
        for (const id of options.expectedSessions) {
          const text = (yield* collect(id)).map((e) => encodeEventLine(e)).join("\n")
          for (const pattern of CREDENTIAL_PATTERNS) expect(text).not.toMatch(pattern)
        }
      }).pipe(Effect.provide(options.layer)))

    it.effect("unknown sessions fail with SessionNotFound", () =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        const error = yield* Effect.flip(bridge.sessions.get(`${options.harness}:does-not-exist`))
        expect(error._tag).toBe("SessionNotFound")
      }).pipe(Effect.provide(options.layer)))

    it.effect("event streams can be interrupted", () =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        const firstTwo = yield* Stream.runCollect(Stream.take(bridge.sessions.events(options.expectedSessions[0]!), 2))
        expect(firstTwo.length).toBe(2)
      }).pipe(Effect.provide(options.layer)))
  })

export interface StoreContractOptions {
  readonly name: string
  readonly layer: Layer.Layer<SessionStore, unknown>
}

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id: id as SessionId,
  harness: { id: "test", name: "Test" } as Session["harness"],
  status: "unknown",
  capabilities: {
    history: true,
    live: false,
    resume: false,
    toolCalls: true,
    toolResults: true,
    reasoning: false,
    tokenUsage: false,
    fileEvents: false,
    commandEvents: false
  },
  metadata: {},
  ...overrides
})

const events = (sessionId: string, count: number): ReadonlyArray<SessionEvent> =>
  Array.from({ length: count }, (_, sequence) => ({
    type: "agent.message",
    id: `evt_${sessionId}_${sequence}`,
    sessionId,
    sequence,
    certainty: "known",
    source: { provider: "test", format: "test" },
    content: [{ type: "text", text: `message ${sequence}` }]
  }) as unknown as SessionEvent)

/** Every SessionStore implementation must pass this suite (spec §64). */
export const storeContract = (options: StoreContractOptions) =>
  describe(`store contract: ${options.name}`, () => {
    const run = <A, E>(effect: Effect.Effect<A, E, SessionStore>) => effect.pipe(Effect.provide(options.layer))

    it.effect("put / get session", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        yield* store.putSession(session("test:a", { title: "A" }), [{ code: "w", message: "m", count: 2 }])
        const found = yield* store.getSession("test:a" as SessionId)
        expect(Option.getOrUndefined(found)?.title).toBe("A")
        expect(yield* store.getWarnings("test:a" as SessionId)).toEqual([{ code: "w", message: "m", count: 2 }])
      })))

    it.effect("fingerprints are stored with the session and replaced with it", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        expect(Option.isNone(yield* store.getFingerprint("test:fp" as SessionId))).toBe(true)
        yield* store.putSession(session("test:fp"), [], "size=1")
        expect(Option.getOrUndefined(yield* store.getFingerprint("test:fp" as SessionId))).toBe("size=1")
        yield* store.putSession(session("test:fp"), [], "size=2")
        expect(Option.getOrUndefined(yield* store.getFingerprint("test:fp" as SessionId))).toBe("size=2")
      })))

    it.effect("missing session is None with no events", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        expect(Option.isNone(yield* store.getSession("test:missing" as SessionId))).toBe(true)
        expect(yield* Stream.runCollect(store.events("test:missing" as SessionId))).toEqual([])
      })))

    it.effect("events come back ordered by sequence", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        const input = events("test:b", 20)
        yield* store.putEvents("test:b" as SessionId, [...input].reverse())
        const back = yield* Stream.runCollect(store.events("test:b" as SessionId))
        expect(back.map((e) => e.sequence)).toEqual(input.map((e) => e.sequence))
      })))

    it.effect("overwrites are idempotent", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        yield* store.putSession(session("test:c", { title: "old" }))
        yield* store.putSession(session("test:c", { title: "new" }))
        yield* store.putEvents("test:c" as SessionId, events("test:c", 5))
        yield* store.putEvents("test:c" as SessionId, events("test:c", 3))
        expect(Option.getOrUndefined(yield* store.getSession("test:c" as SessionId))?.title).toBe("new")
        expect((yield* Stream.runCollect(store.events("test:c" as SessionId))).length).toBe(3)
        expect((yield* Stream.runCollect(store.query({}))).filter((s) => s.id === "test:c").length).toBe(1)
      })))

    it.effect("query filters and orders", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        yield* store.putSession(session("test:1", { projectPath: "/p", startedAt: "2026-01-01T00:00:00.000Z" }))
        yield* store.putSession(session("test:2", { projectPath: "/p", startedAt: "2026-03-01T00:00:00.000Z" }))
        yield* store.putSession(session("test:3", { projectPath: "/q", startedAt: "2026-02-01T00:00:00.000Z" }))
        const inP = yield* Stream.runCollect(store.query({ projectPath: "/p" }))
        expect(inP.map((s) => s.id)).toEqual(["test:2", "test:1"])
        const recent = yield* Stream.runCollect(store.query({ startedAfter: "2026-01-15T00:00:00.000Z", limit: 1 }))
        expect(recent.map((s) => s.id)).toEqual(["test:2"])
        expect((yield* Stream.runCollect(store.query({ harness: "other" }))).length).toBe(0)
      })))

    it.effect("compares offset timestamps by instant, with stable ties", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        yield* store.putSession(session("test:earlier", { startedAt: "2026-01-01T01:00:00+02:00" }))
        yield* store.putSession(session("test:later", { startedAt: "2026-01-01T00:00:00Z" }))
        yield* store.putSession(session("test:equal", { startedAt: "2026-01-01T00:00:00.000Z" }))
        expect((yield* Stream.runCollect(store.query({}))).map((s) => s.id)).toEqual(["test:equal", "test:later", "test:earlier"])
        expect(yield* Stream.runCollect(store.query({ startedAfter: "2026-01-01T00:00:00Z" }))).toEqual([])
      })))

    it.effect("large event sequences round-trip", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        yield* store.putEvents("test:big" as SessionId, events("test:big", 10_000))
        const count = yield* Stream.runCount(store.events("test:big" as SessionId))
        expect(count).toBe(10_000)
      })))

    it.effect("event streams can be interrupted", () =>
      run(Effect.gen(function*() {
        const store = yield* SessionStore
        yield* store.putEvents("test:int" as SessionId, events("test:int", 1_000))
        const fiber = yield* Effect.forkChild(Stream.runDrain(store.events("test:int" as SessionId).pipe(Stream.forever)))
        yield* Fiber.interrupt(fiber)
        const taken = yield* Stream.runCollect(Stream.take(store.events("test:int" as SessionId), 10))
        expect(taken.length).toBe(10)
      })))
  })
