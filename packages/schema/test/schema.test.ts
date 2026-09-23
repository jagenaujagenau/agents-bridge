import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  decodeEventLineTolerant,
  encodeEventLine,
  jsonSchemaDocuments,
  parseSessionId,
  Session,
  SessionEvent,
  sha256Hex,
  stableEventId,
  validateEvent,
  validateSession
} from "../src/index.ts"

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const canonicalEvents = readFileSync(fixture("canonical-session/events.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as unknown)
const canonicalSession = JSON.parse(readFileSync(fixture("canonical-session/session.json"), "utf8")) as unknown

describe("canonical fixtures", () => {
  it("session validates and round-trips", () => {
    const decoded = validateSession(canonicalSession)
    expect(Schema.encodeSync(Session)(decoded)).toEqual(canonicalSession)
  })

  it("covers every canonical event type", () => {
    const types = new Set(canonicalEvents.map((event) => (event as { type: string }).type))
    for (const type of ["session.started", "user.message", "agent.message", "tool.started", "command.completed"]) {
      expect(types.has(type)).toBe(true)
    }
  })

  it.each(canonicalEvents.map((event, index) => [index, event] as const))("event %i round-trips", (_, event) => {
    const decoded = validateEvent(event)
    const line = encodeEventLine(decoded)
    expect(JSON.parse(line)).toEqual(event)
  })
})

describe("rejection", () => {
  const valid = canonicalEvents[1] as Record<string, unknown>

  it.each([
    ["missing id", { ...valid, id: undefined }],
    ["negative sequence", { ...valid, sequence: -1 }],
    ["fractional sequence", { ...valid, sequence: 1.5 }],
    ["bad certainty", { ...valid, certainty: "maybe" }],
    ["bad timestamp", { ...valid, timestamp: "yesterday" }],
    ["unknown type", { ...valid, type: "user.mesage" }],
    ["Effect _tag instead of type", { ...valid, type: undefined, _tag: valid["type"] }]
  ])("rejects %s", (_, input) => {
    expect(() => validateEvent(JSON.parse(JSON.stringify(input)))).toThrow()
  })

  it("command.completed requires an outcome", () => {
    const completed = canonicalEvents.find((e) => (e as { type: string }).type === "command.completed") as object
    expect(() => validateEvent({ ...completed, outcome: undefined })).toThrow()
  })
})

describe("forward compatibility", () => {
  it.effect("tolerant reader skips unknown event types", () =>
    Effect.gen(function*() {
      const future = JSON.stringify({ ...(canonicalEvents[1] as object), type: "session.paused" })
      expect(Option.isNone(yield* decodeEventLineTolerant(future))).toBe(true)
      const known = JSON.stringify(canonicalEvents[1])
      expect(Option.isSome(yield* decodeEventLineTolerant(known))).toBe(true)
    }))

  it.effect("tolerant reader still fails malformed known events", () =>
    Effect.gen(function*() {
      const broken = JSON.stringify({ ...(canonicalEvents[1] as object), sequence: "x" })
      const result = yield* Effect.exit(decodeEventLineTolerant(broken))
      expect(result._tag).toBe("Failure")
    }))

  it("custom events decode", () => {
    const custom = { ...(canonicalEvents[1] as object), type: "custom.claude-code.hook", payload: { a: 1 } }
    delete (custom as Record<string, unknown>)["content"]
    expect(validateEvent(custom).type).toBe("custom.claude-code.hook")
  })
})

describe("property tests", () => {
  it.effect("arbitrary events encode → JSON → decode losslessly", () =>
    Effect.gen(function*() {
      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(SessionEvent),
        (event) => {
          const line = encodeEventLine(event)
          const back = validateEvent(JSON.parse(line))
          return JSON.stringify(Schema.encodeSync(SessionEvent)(back)) === line
        },
        { runs: 200 }
      )
      expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
    }))

  it.effect("arbitrary sessions round-trip", () =>
    Effect.gen(function*() {
      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Session),
        (session) => {
          const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(Session)(session)))
          return JSON.stringify(Schema.encodeSync(Session)(validateSession(encoded))) === JSON.stringify(encoded)
        },
        { runs: 100 }
      )
      expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
    }))
})

describe("ids", () => {
  it("sha256 matches a reference implementation", () => {
    for (const input of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "héllo 🌍 ".repeat(40)]) {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"))
    }
  })

  it("stable event ids are deterministic and anchor-sensitive", () => {
    const base = { harness: "codex", sessionId: "codex:1", canonicalType: "tool.started", derivationIndex: 0 }
    expect(stableEventId({ ...base, recordIndex: 3 })).toBe(stableEventId({ ...base, recordIndex: 3 }))
    expect(stableEventId({ ...base, recordIndex: 3 })).not.toBe(stableEventId({ ...base, recordIndex: 4 }))
    expect(stableEventId({ ...base, recordIndex: 3 })).not.toBe(stableEventId({ ...base, nativeEventId: "3" }))
    expect(stableEventId({ ...base, recordIndex: 3 })).toMatch(/^evt_[0-9a-f]{32}$/)
  })

  it("session ids parse", () => {
    expect(parseSessionId("claude-code:abc/agent-1")).toEqual({ harness: "claude-code", nativeId: "abc/agent-1" })
    expect(parseSessionId("nocolon")).toBeUndefined()
  })
})

describe("json schema", () => {
  it("generates documents for the published protocol types", () => {
    const docs = jsonSchemaDocuments()
    expect(Object.keys(docs).sort()).toEqual([
      "event.schema.json",
      "import-warning.schema.json",
      "manifest.schema.json",
      "session.schema.json"
    ])
    const event = JSON.stringify(docs["event.schema.json"])
    expect(event).toContain("command.completed")
    expect(event).not.toContain("_tag")
  })

  it("committed schemas/v1 match the generated documents", () => {
    const docs = jsonSchemaDocuments()
    for (const [name, doc] of Object.entries(docs)) {
      const path = fileURLToPath(new URL(`../../../schemas/v1/${name}`, import.meta.url))
      expect(JSON.parse(readFileSync(path, "utf8")), `${name} is stale: run pnpm schemas`).toEqual(doc)
    }
  })
})
