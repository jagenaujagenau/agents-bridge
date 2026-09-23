import type { SessionEvent } from "@agentbridge/schema"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { enrichStream, gitEnricher, redactionEnricher, redactText } from "../src/index.ts"

const base = (sequence: number) => ({
  id: `evt_${sequence}`,
  sessionId: "t:1",
  sequence,
  certainty: "known" as const,
  source: { provider: "t", format: "t" }
})
const run = (events: ReadonlyArray<object>, enrichers = [gitEnricher]) =>
  Effect.runSync(Stream.runCollect(Stream.fromIterable(events as ReadonlyArray<SessionEvent>).pipe(enrichStream(enrichers))))

describe("gitEnricher", () => {
  it("derives commits from successful git commit commands and resequences", () => {
    const events = run([
      { ...base(0), type: "command.started", commandId: "c1", command: "git add -A && git commit -m \"Add usage docs\"" },
      { ...base(1), type: "command.completed", commandId: "c1", outcome: "succeeded", stdout: "[main 1a2b3c4] Add usage docs\n 1 file changed" },
      { ...base(2), type: "command.started", commandId: "c2", command: "git commit -m 'nope'" },
      { ...base(3), type: "command.completed", commandId: "c2", outcome: "failed" },
      { ...base(4), type: "command.started", commandId: "c3", command: "git commit -am wip" },
      { ...base(5), type: "command.completed", commandId: "c3", outcome: "unknown" },
      { ...base(6), type: "agent.message", content: [] }
    ])
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const commits = events.filter((e) => e.type === "git.commit")
    expect(commits).toMatchObject([
      { branch: "main", commit: "1a2b3c4", message: "Add usage docs", certainty: "inferred", derivedFrom: ["evt_0", "evt_1"] },
      { message: "wip" }
    ])
    expect(commits[0]!.id).toMatch(/^evt_[0-9a-f]{32}$/)
  })
})

describe("redaction", () => {
  it("masks common secret shapes and keeps names and structure", () => {
    expect(redactText("token ghp_" + "a".repeat(36))).toBe("token [REDACTED:github-token]")
    expect(redactText("Authorization: Bearer " + "x".repeat(30))).toBe("Authorization: Bearer [REDACTED:bearer-token]")
    expect(redactText("export OPENAI_API_KEY=abcdefgh12345")).toBe("export OPENAI_API_KEY=[REDACTED:env-secret]")
    expect(redactText("AKIAABCDEFGHIJKLMNOP")).toBe("[REDACTED:aws-access-key]")
    expect(redactText("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED:private-key]")
    expect(redactText("nothing secret here, PATH=/usr/bin")).toBe("nothing secret here, PATH=/usr/bin")
  })

  it("redacts content but never identity fields", () => {
    const [event] = run([
      { ...base(0), type: "command.started", commandId: "sk-ant-" + "b".repeat(30), command: "curl -H 'Bearer " + "y".repeat(30) + "'" }
    ], [redactionEnricher])
    expect(event).toMatchObject({ commandId: "sk-ant-" + "b".repeat(30), command: "curl -H 'Bearer [REDACTED:bearer-token]'" })
  })
})
