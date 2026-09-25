import type { Session, SessionEvent } from "@agentbridge/schema"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { commitMessage, commitSubject, enrichStream, gitEnricher, type GitRepositoryShape, redactionEnricher, redactSession, redactText, verifyGitCommit } from "../src/index.ts"

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
    // Inline assignments later in a command line, not only at its start.
    expect(redactText("REPLAY_JEV=1 TYPESAFE_API_KEY=abcdefgh12345 node run.ts")).toBe(
      "REPLAY_JEV=1 TYPESAFE_API_KEY=[REDACTED:env-secret] node run.ts"
    )
    expect(redactText("cd app && GITHUB_TOKEN=abcdefgh12345 gh pr list")).toBe(
      "cd app && GITHUB_TOKEN=[REDACTED:env-secret] gh pr list"
    )
    expect(redactText("use this key: apikey_" + "a1".repeat(18) + "_" + "b2".repeat(32))).toBe(
      "use this key: [REDACTED:typesafe-key]"
    )
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

describe("verifyGitCommit", () => {
  const fake: GitRepositoryShape = {
    hasCommit: (_, commit) => Effect.succeed(commit === "1a2b3c4"),
    findCommit: (_, subject) => Effect.succeed(subject === "wip" ? Option.some({ commit: "9f9f9f9", branch: "main" }) : Option.none())
  }
  const commit = (fields: object) =>
    ({ ...base(0), type: "git.commit", certainty: "inferred", timestamp: "2026-09-01T10:00:00.000Z", ...fields }) as SessionEvent
  const verify = (event: SessionEvent, project: string | undefined) => Effect.runSync(verifyGitCommit(fake, project)(event))

  it("marks commits found in the repository as known", () => {
    expect(verify(commit({ commit: "1a2b3c4" }), "/repo")).toMatchObject({ certainty: "known", commit: "1a2b3c4" })
    expect(verify(commit({ commit: "0000000" }), "/repo")).toMatchObject({ certainty: "inferred" })
    expect(verify(commit({ message: "wip" }), "/repo")).toMatchObject({ certainty: "known", commit: "9f9f9f9", branch: "main" })
    expect(verify(commit({ message: "other" }), "/repo")).toMatchObject({ certainty: "inferred" })
    expect(verify(commit({ commit: "1a2b3c4" }), undefined)).toMatchObject({ certainty: "inferred" })
    expect(verify(commit({ commit: "--upload-pack=x" }), "/repo")).toMatchObject({ certainty: "inferred" })
  })
})

describe("redactSession", () => {
  it("masks title, agent label and metadata strings", () => {
    const key = "sk-ant-" + "c".repeat(30)
    const session = redactSession({
      id: "t:1",
      harness: { id: "t", name: "T" },
      status: "unknown",
      title: `use ${key}`,
      projectPath: "/p",
      capabilities: { history: true, live: false, resume: false, toolCalls: true, toolResults: true, reasoning: false, tokenUsage: false, fileEvents: false, commandEvents: false },
      metadata: { note: { deep: [key] }, model: "m" }
    } as unknown as Session)
    expect(session).toMatchObject({
      title: "use [REDACTED:anthropic-key]",
      projectPath: "/p",
      metadata: { note: { deep: ["[REDACTED:anthropic-key]"] }, model: "m" }
    })
  })
})

describe("commit messages", () => {
  it("reads heredoc, multi-line and flag forms", () => {
    expect(commitMessage("git add . && git commit -q -F - <<'EOF'\nfeat: x\n\nbody\nEOF")).toBe("feat: x\n\nbody")
    expect(commitMessage(`git commit -m "$(cat <<'EOF'\nfix: y\nEOF\n)"`)).toBe("fix: y")
    expect(commitMessage(`git commit -q -am "copy: z\n\nCo-Authored-By: a"`)).toBe("copy: z\n\nCo-Authored-By: a")
    expect(commitMessage("git commit --amend --no-edit")).toBeUndefined()
    expect(commitSubject("copy: z\n\nbody")).toBe("copy: z")
  })

  it("takes the hash from `git log --oneline` output when git commit ran quietly", () => {
    const [, commit] = run([
      { ...base(0), type: "command.started", commandId: "c1", command: "git commit -q -m \"feat: x\n\nbody\" && git log --oneline -1" },
      { ...base(1), type: "command.completed", commandId: "c1", outcome: "succeeded", stdout: "0b0addc feat: x" }
    ]).slice(1)
    expect(commit).toMatchObject({ type: "git.commit", commit: "0b0addc", message: "feat: x\n\nbody" })
  })
})
