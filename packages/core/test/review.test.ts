import { describe, expect, it } from "@effect/vitest"
import { Effect, Path, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Timestamp, makeSessionId, HarnessId } from "@agentbridge/schema"
import { Emission, loadSession, normalizeTimestamp } from "../src/normalize.ts"
import { cacheDiscovery, isWithinProject } from "../src/sources.ts"

const capabilities = { history: true, live: false, resume: false, toolCalls: false, toolResults: false, reasoning: false, tokenUsage: false, fileEvents: false, commandEvents: false }

describe("timestamp and warning regressions", () => {
  it.effect("refreshes discovery on demand and after expiry, without caching failures", () =>
    Effect.gen(function*() {
      let scans = 0
      const cache = yield* cacheDiscovery(Effect.sync(() => ++scans))
      expect(yield* cache.get).toBe(1)
      expect(yield* cache.get).toBe(1)
      expect(yield* cache.refresh).toBe(2)
      yield* TestClock.adjust("6 seconds")
      expect(yield* cache.get).toBe(3)
      let failed = 0
      const errors = yield* cacheDiscovery(Effect.suspend(() => ++failed === 1 ? Effect.fail("retry") : Effect.succeed("ok")))
      yield* Effect.flip(errors.get)
      expect(yield* errors.get).toBe("ok")
    }))

  it.effect("filters projects by directory boundaries", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      expect(isWithinProject(path, "/work/app", "/work/app/")).toBe(true)
      expect(isWithinProject(path, "/work/app/src", "/work/app")).toBe(true)
      expect(isWithinProject(path, "/work/application", "/work/app")).toBe(false)
      expect(isWithinProject(path, "/work/app/../other", "/work/app")).toBe(false)
      expect(isWithinProject(path, "/work/app", "/")).toBe(true)
      expect(isWithinProject(path, undefined, "/work/app")).toBe(false)
    }).pipe(Effect.provide(Path.layer)))

  it("rejects impossible dates, including calendar overflow", () => {
    for (const value of ["2026-99-99T99:99:99Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+24:00"]) {
      expect(Schema.is(Timestamp)(value), value).toBe(false)
      expect(normalizeTimestamp(value), value).toBeUndefined()
    }
    for (const value of ["2024-02-29T00:00:00Z", "2026-01-01T01:00:00.123456+02:00"]) {
      expect(Schema.is(Timestamp)(value)).toBe(true)
      expect(normalizeTimestamp(value)).toBe(value)
    }
  })

  it.effect("aggregates repeated warnings and keeps their first provenance", () =>
    Effect.gen(function*() {
      const result = yield* loadSession(
        { id: makeSessionId("test", "s"), nativeId: "s", harness: Schema.decodeUnknownSync(HarnessId)("test"), sourcePath: "test" },
        { harness: { id: Schema.decodeUnknownSync(HarnessId)("test"), name: "Test" }, capabilities },
        Stream.range(0, 9999).pipe(Stream.map((recordIndex) => Emission.warning({ code: "malformed_json", message: "bad", source: { provider: "test", format: "test", recordIndex } })))
      )
      expect(result.warnings).toEqual([{ code: "malformed_json", message: "bad", count: 10000, source: { provider: "test", format: "test", recordIndex: 0 } }])
    }))
})
