import type { EventId, Session, SessionEvent, SessionId, ToolCallId } from "@agentbridge/schema"
import { describe, expect, it } from "vitest"
import { type CheckJudgment, type CommandKindJudgment, deriveReplay } from "../src/index.ts"
import { checkRequest, JEV_ENDPOINT, jevConfig, judgeCheck, outputTail } from "../src/server/jev.ts"

const sessionId = "test:jev" as SessionId
const session: Session = {
  id: sessionId,
  harness: { id: "test" as Session["harness"]["id"], name: "Test" },
  status: "unknown",
  projectPath: "/repo",
  capabilities: {
    history: true, live: false, resume: false, toolCalls: true, toolResults: true,
    reasoning: false, tokenUsage: false, fileEvents: true, commandEvents: true
  },
  metadata: {}
}

/** Canonical events for runs of commands, with recorded output. */
const build = () => {
  const events: Array<SessionEvent> = []
  const base = () => ({
    id: `evt_${events.length}` as EventId,
    sessionId,
    sequence: events.length,
    certainty: "known" as const,
    source: { provider: "test", format: "test" }
  })
  return {
    events,
    run: (command: string, exitCode: number, stdout: string) => {
      const toolCallId = `t${events.length}` as ToolCallId
      const tool = { ...base(), type: "tool.started" as const, toolCallId, name: "shell", kind: "execute" as const }
      events.push(tool)
      const commandId = `cmd${events.length}` as never
      events.push({ ...base(), type: "command.started", commandId, command, parentEventId: tool.id })
      events.push({
        ...base(),
        type: "command.completed",
        commandId,
        outcome: exitCode === 0 ? "succeeded" : "failed",
        exitCode,
        stdout,
        parentEventId: tool.id
      })
      return commandId as string
    },
    prompt: (text: string) => events.push({ ...base(), type: "user.message", content: [{ type: "text", text }] }),
    reply: (text: string) => {
      events.push({ ...base(), type: "agent.message", content: [{ type: "text", text }] })
      return events.at(-1)!.id as string
    },
    change: (path: string) => {
      const tool = { ...base(), type: "tool.started" as const, toolCallId: `t${events.length}` as ToolCallId, name: "edit", kind: "edit" as const }
      events.push(tool)
      events.push({ ...base(), type: "file.changed", path: `/repo/${path}`, parentEventId: tool.id })
    }
  }
}

const judgment = (outcome: CheckJudgment["outcome"], confidence: number): CheckJudgment => ({
  outcome,
  probabilities: { passed: 0, failed: 0, unclear: 0, [outcome]: 1 },
  confidence,
  model: "jev-1.13.0"
})

describe("judged check results in the story", () => {
  it("lists checks the shell hid, and fills them in from confident judgments", () => {
    const s = build()
    const failing = s.run("pnpm test 2>&1 | tail -20", 0, "Tests  1 failed | 11 passed")
    s.change("a.ts")
    const passing = s.run("pnpm test 2>&1 | tail -20", 0, "Tests  12 passed")

    const plain = deriveReplay(session, s.events)
    expect(plain.checksToJudge).toEqual([failing, passing])
    expect(plain.scenes.map((sc) => sc.title)).toEqual([
      "Ran tests → outcome unknown",
      "Changed a.ts",
      "Ran tests → outcome unknown"
    ])

    const judged = deriveReplay(session, s.events, [], {
      judgments: new Map([[failing, judgment("failed", 0.95)], [passing, judgment("passed", 0.9)]])
    })
    expect(judged.checksToJudge).toEqual([])
    expect(judged.chapters.map((c) => [c.kind, c.title, c.derivation])).toEqual([
      ["debugging", "Fixed failing tests (inferred)", "ai"]
    ])
    expect(judged.scenes[2]!.check).toMatchObject({ inferred: { model: "jev-1.13.0", confidence: 0.9 } })
    expect(judged.stats.checks).toMatchObject([{ outcome: "passed", inferred: { model: "jev-1.13.0" } }])
    expect(judged.summary).toContain("Passed at its last run: tests (inferred).")
  })

  it("leaves results unknown when the judgment is unclear or not confident", () => {
    const s = build()
    const a = s.run("pnpm test | tail", 0, "…")
    const b = s.run("pnpm lint | tail", 0, "…")
    const replay = deriveReplay(session, s.events, [], {
      judgments: new Map([[a, judgment("unclear", 0.9)], [b, judgment("passed", 0.3)]])
    })
    expect(replay.scenes.map((sc) => sc.title)).toEqual(["Ran tests → outcome unknown", "Ran the linter → outcome unknown"])
    // Already asked; not asked again.
    expect(replay.checksToJudge).toEqual([])
  })

  it("never overrides a recorded result, and never judges checks without output", () => {
    const s = build()
    const recorded = s.run("pnpm test", 1, "1 failed")
    s.run("pnpm build | tail", 0, "")
    const replay = deriveReplay(session, s.events, [], { judgments: new Map([[recorded, judgment("passed", 0.99)]]) })
    expect(replay.scenes[0]!.title).toBe("Ran tests → failed")
    expect(deriveReplay(session, s.events).checksToJudge).toEqual([])
  })
})

const says = (done: number, testsPass: number, checksPass = 0, openProblem = 0) => ({
  done, testsPass, checksPass, openProblem, model: "jev-1.13.0"
})

const kind = (k: CommandKindJudgment["kind"], confidence: number): CommandKindJudgment => ({
  kind: k, confidence, probabilities: { [k]: confidence }, model: "jev-1.13.0"
})

describe("commands the rules do not recognise", () => {
  it("become checks only on a confident judgment, and then have their hidden result judged", () => {
    const s = build()
    const selftest = s.run("bash scripts/local-check-selftest.sh 2>&1 | tail -5", 0, "378 passed, no failures")
    const server = s.run("bun run src/main.ts", 0, "listening on :3000")
    const unsure = s.run("python3 scripts/probe.py", 0, "ok")

    const plain = deriveReplay(session, s.events)
    expect(plain.commandsToClassify).toEqual([selftest, server, unsure])
    expect(plain.scenes.map((sc) => sc.kind)).toEqual(["command"])

    const kinds = new Map([[selftest, kind("tests", 0.9)], [server, kind("not_a_check", 0.95)], [unsure, kind("tests", 0.4)]])
    const identified = deriveReplay(session, s.events, [], { commandKinds: kinds })
    expect(identified.commandsToClassify).toEqual([])
    expect(identified.scenes.map((sc) => [sc.kind, sc.title])).toEqual([
      ["validate", "Ran tests → outcome unknown (inferred)"],
      ["command", "Ran 2 commands"]
    ])
    // Piped into tail, so its result is hidden and goes to the next round.
    expect(identified.checksToJudge).toEqual([selftest])

    const judged = deriveReplay(session, s.events, [], { commandKinds: kinds, judgments: new Map([[selftest, judgment("passed", 0.9)]]) })
    expect(judged.scenes[0]!.title).toBe("Ran tests → passed (inferred)")
  })
})

describe("what the agent said, against what was recorded", () => {
  it("flags claimed passes that the turn's checks contradict or cannot support", () => {
    const s = build()
    s.prompt("Fix the tests")
    s.run("pnpm test", 1, "1 failed")
    const contradicted = s.reply("Done, all tests pass.")
    s.prompt("Tidy the README")
    s.change("README.md")
    const unsupported = s.reply("Done; tests pass and the build is green.")
    s.prompt("Run the suite")
    s.run("pnpm test", 0, "12 passed")
    const supported = s.reply("Tests pass.")

    const plain = deriveReplay(session, s.events)
    expect(plain.repliesToJudge).toEqual([contradicted, unsupported, supported])
    expect(plain.turns).toEqual([])

    const judged = deriveReplay(session, s.events, [], {
      replies: new Map([
        [contradicted, says(0.9, 0.95)],
        [unsupported, says(0.9, 0.9, 0.8)],
        [supported, says(0.8, 0.97)]
      ])
    })
    expect(judged.repliesToJudge).toEqual([])
    expect(judged.turns.map((t) => t.conflicts)).toEqual([
      ["Says tests pass, but the last test run in this request failed."],
      [
        "Says tests pass, but no test ran in this request.",
        "Says the build, type check or lint passes, but no build, type check or lint ran in this request."
      ],
      []
    ])
    expect(judged.turns[0]!.says).toEqual({ done: true, testsPass: true, checksPass: false, openProblem: false })
  })
})

describe("Jev request and response", () => {
  it("sends only the cleaned tail of the output", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
    const tail = outputTail(`\u001b[32m${long}\u001b[0m\r\n`, "warning: x")
    expect(tail.split("\n")).toHaveLength(80)
    expect(tail.endsWith("warning: x")).toBe(true)
    expect(tail).not.toContain("\u001b")
    expect(outputTail(undefined, "  ")).toBe("")
  })

  it("asks one Choice with passed, failed and unclear", () => {
    const body = checkRequest("jev-latest", { command: "pnpm test | tail", kind: "tests", output: "12 passed" })
    expect(body).toMatchObject({
      model: "jev-latest",
      state: { check: { command: "pnpm test | tail", runs: "a test suite" }, output: "12 passed" },
      questions: { result: { type: "choice" } }
    })
    expect(Object.keys(body.questions.result.criteria)).toEqual(["passed", "failed", "unclear"])
  })

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const answer = {
    model: "jev-1.13.0",
    answers: { result: { type: "choice", choice: "passed", probabilities: { passed: 0.9, failed: 0.05, unclear: 0.05 }, confidence: 0.85 } },
    usage: { input_tokens: 300, output_tokens: 20 }
  }
  const check = { command: "pnpm test | tail", kind: "tests" as const, output: "12 passed" }
  const config = { apiKey: "test-key", model: "jev-latest" }

  it("parses a Choice answer and reports the versioned model", async () => {
    const calls: Array<[string, RequestInit]> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init])
      return reply(200, answer)
    }) as unknown as typeof fetch
    expect(await judgeCheck(config, check, fetchImpl)).toEqual({
      outcome: "passed",
      probabilities: { passed: 0.9, failed: 0.05, unclear: 0.05 },
      confidence: 0.85,
      model: "jev-1.13.0"
    })
    expect(calls[0]![0]).toBe(JEV_ENDPOINT)
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer test-key")
  })

  it("retries rate limits, and fails on other errors or unexpected answers", async () => {
    let n = 0
    const flaky = (async () => (n++ === 0 ? reply(429, {}) : reply(200, answer))) as unknown as typeof fetch
    expect((await judgeCheck(config, check, flaky)).outcome).toBe("passed")
    expect(n).toBe(2)

    const denied = (async () => reply(401, { detail: "bad key" })) as unknown as typeof fetch
    await expect(judgeCheck(config, check, denied)).rejects.toThrow("401")

    const odd = (async () => reply(200, { model: "jev", answers: { result: { type: "noul", noul: 1 } } })) as unknown as typeof fetch
    await expect(judgeCheck(config, check, odd)).rejects.toThrow("unexpected answer")
  })

  it("is off unless explicitly enabled with a key", () => {
    expect(jevConfig({ TYPESAFE_API_KEY: "k" })).toBeUndefined()
    expect(jevConfig({ REPLAY_JEV: "1" })).toBeUndefined()
    expect(jevConfig({ REPLAY_JEV: "1", TYPESAFE_API_KEY: "k" })).toEqual({ apiKey: "k", model: "jev-1.13.0" })
    expect(jevConfig({ REPLAY_JEV: "1", TYPESAFE_API_KEY: "k", REPLAY_JEV_MODEL: "jev-latest" })?.model).toBe("jev-latest")
  })
})
