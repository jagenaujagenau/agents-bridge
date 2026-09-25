import { Bridge } from "@agentbridge/core"
import { NodeBridge } from "@agentbridge/platform-node"
import type { EventId, Session, SessionEvent, SessionId, ToolCallId } from "@agentbridge/schema"
import { fixtureBridgeOptions, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { classifyCommand, deriveReplay, diffStat, loadReplaySession, parseDiff, type ReplaySession } from "../src/index.ts"

const layer = NodeBridge.layer(fixtureBridgeOptions)

/** What a reader of the story sees, minus IDs and timestamps. */
const story = (replay: ReplaySession) => ({
  title: replay.title,
  summary: replay.summary,
  chapters: replay.chapters.map((c) => ({
    kind: c.kind,
    title: c.title,
    summary: c.summary,
    scenes: c.sceneIds.map((id) => replay.scenes.find((s) => s.id === id)!).map((s) => [s.kind, s.title, s.filePaths])
  })),
  files: [...replay.files.values()].map((f) => [f.path, f.region, f.activity, f.readCount, f.changeCount]),
  map: [...replay.map.nodes]
})

/** Structural invariants every derived Replay must hold. */
const checkInvariants = (replay: ReplaySession) => {
  const ids = new Set(replay.events.map((e) => e.id))
  // Every event belongs to exactly one scene, and every scene is backed by evidence.
  expect(replay.eventIndex.sceneByEvent.size).toBe(replay.events.length)
  const covered = replay.scenes.flatMap((s) => s.eventIds)
  expect(new Set(covered).size).toBe(covered.length)
  for (const scene of replay.scenes) {
    expect(scene.eventIds.length).toBeGreaterThan(0)
    for (const id of scene.eventIds) expect(ids.has(id)).toBe(true)
  }
  // Chapters partition scenes in order.
  expect(replay.chapters.flatMap((c) => c.sceneIds)).toEqual(replay.scenes.map((s) => s.id))
  for (const chapter of replay.chapters) {
    for (const id of chapter.sceneIds) expect(replay.scenes.find((s) => s.id === id)?.chapterId).toBe(chapter.id)
  }
  // Every file is on the map, inside its bounds.
  for (const file of replay.files.values()) {
    const node = replay.map.nodes.get(file.path)
    expect(node, file.path).toBeDefined()
    expect(node!.x - node!.radius).toBeGreaterThanOrEqual(-0.001)
    expect(node!.x + node!.radius).toBeLessThanOrEqual(replay.map.size + 0.001)
  }
  // The timeline only points at real events, in order.
  const sequences = replay.timeline.entries.map((e) => e.sequence)
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
  for (const entry of replay.timeline.entries) expect(ids.has(entry.eventId)).toBe(true)
}

describe("Replay derivation on Bridge fixtures", () => {
  it.effect("Claude Code and Codex produce the same story and map (GOAL §43)", () =>
    Effect.gen(function*() {
      const claude = yield* loadReplaySession(scenario.claude)
      const codex = yield* loadReplaySession(scenario.codex)
      expect(story(codex)).toEqual(story(claude))
      expect(story(claude).chapters).toEqual([
        {
          kind: "implementation",
          title: "Changed README.md",
          summary: "Read 1 file, changed 1 file",
          scenes: [["change", "Changed README.md", ["README.md"]]]
        },
        {
          kind: "debugging",
          title: "Fixed failing tests",
          summary: "Changed 1 file, ran 2 commands (1 failed), tests passed",
          scenes: [
            ["validate", "Ran tests → failed", []],
            ["change", "Created usage.md", ["docs/usage.md"]],
            ["validate", "Ran tests → passed", []]
          ]
        }
      ])
    }).pipe(Effect.provide(layer)))

  it.effect("every fixture session of every harness derives a valid Replay", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const sessions = yield* Stream.runCollect(bridge.sessions.list())
      expect(sessions.length).toBeGreaterThan(8)
      for (const descriptor of sessions) checkInvariants(yield* loadReplaySession(descriptor.id))
    }).pipe(Effect.provide(layer)))

  it.effect("map geography is identical across derivations", () =>
    Effect.gen(function*() {
      const a = yield* loadReplaySession(scenario.claude)
      const b = yield* loadReplaySession(scenario.claude)
      expect([...b.map.nodes]).toEqual([...a.map.nodes])
      expect(b.map.regions).toEqual(a.map.regions)
    }).pipe(Effect.provide(layer)))
})

// ---------------------------------------------------------------------------
// GOAL §39, built from canonical events directly.
// ---------------------------------------------------------------------------

const sessionId = "test:auth" as SessionId
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

const build = () => {
  const events: Array<SessionEvent> = []
  const base = () => {
    const sequence = events.length
    return {
      id: `evt_${sequence}` as EventId,
      sessionId,
      sequence,
      timestamp: new Date(Date.UTC(2026, 8, 1, 10, 0, sequence)).toISOString(),
      certainty: "known" as const,
      source: { provider: "test", format: "test" }
    }
  }
  const tool = (kind: "read" | "edit" | "execute") => {
    const started = { ...base(), type: "tool.started" as const, toolCallId: `t${events.length}` as ToolCallId, name: kind, kind }
    events.push(started)
    return started
  }
  return {
    events,
    prompt: (text: string) => events.push({ ...base(), type: "user.message", content: [{ type: "text", text }] }),
    read: (path: string) => {
      const t = tool("read")
      events.push({ ...base(), type: "tool.completed", toolCallId: t.toolCallId })
      events.push({ ...base(), type: "file.read", path: `/repo/${path}`, parentEventId: t.id })
    },
    change: (path: string) => {
      const t = tool("edit")
      events.push({ ...base(), type: "tool.completed", toolCallId: t.toolCallId })
      events.push({ ...base(), type: "file.changed", path: `/repo/${path}`, parentEventId: t.id, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" })
    },
    run: (command: string, exitCode: number | "interrupted") => {
      const t = tool("execute")
      const commandId = `c${events.length}` as never
      events.push({ ...base(), type: "command.started", commandId, command, parentEventId: t.id })
      events.push({ ...base(), type: "tool.completed", toolCallId: t.toolCallId })
      events.push({
        ...base(),
        type: "command.completed",
        commandId,
        ...(exitCode === "interrupted"
          ? { outcome: "interrupted" as const }
          : { outcome: exitCode === 0 ? "succeeded" as const : "failed" as const, exitCode }),
        parentEventId: t.id
      })
    },
    /** A command with no tool and no parent links: results join by `commandId` alone. */
    shell: (command: string, outcome: "succeeded" | "failed") => {
      const commandId = `c${events.length}` as never
      events.push({ ...base(), type: "command.started", commandId, command })
      events.push({ ...base(), type: "command.completed", commandId, outcome })
    },
    /** A tool whose kind and name only arrive in a later `tool.updated`. */
    lateTool: (kind: "edit", name: string) => {
      const t = { ...base(), type: "tool.started" as const, toolCallId: `t${events.length}` as ToolCallId, name: "pending", kind: "other" as const }
      events.push(t)
      events.push({ ...base(), type: "tool.updated", toolCallId: t.toolCallId, kind, name, input: { path: "a.ts" } })
      events.push({ ...base(), type: "tool.failed", toolCallId: t.toolCallId, message: "patch did not apply" })
    },
    reply: (text: string) => events.push({ ...base(), type: "agent.message", content: [{ type: "text", text }] })
  }
}

describe("deterministic story (GOAL §39)", () => {
  it("explores, changes, then fixes failing tests", () => {
    const s = build()
    s.prompt("Persist sessions across restarts")
    s.read("src/auth/auth.ts")
    s.read("src/auth/session.ts")
    s.read("src/auth/middleware.ts")
    s.change("src/auth/session.ts")
    s.change("src/auth/auth.ts")
    s.run("pnpm test auth", 1)
    s.read("src/auth/auth.test.ts")
    s.change("src/auth/auth.ts")
    s.run("pnpm test auth", 0)
    s.reply("Sessions now persist.")
    const replay = deriveReplay(session, s.events)
    checkInvariants(replay)

    expect(replay.chapters.map((c) => [c.kind, c.title])).toEqual([
      ["exploration", "Explored src/auth"],
      ["implementation", "Changed session.ts and auth.ts"],
      ["debugging", "Fixed failing tests"]
    ])
    expect(replay.scenes.map((sc) => sc.title)).toEqual([
      "Explored src/auth",
      "Changed session.ts and auth.ts",
      "Ran tests → failed",
      "Changed auth.ts",
      "Ran tests → passed"
    ])
    // The prompt opens the story; the closing reply stays with the last scene.
    expect(replay.chapters[0]!.promptEventId).toBe("evt_0")
    expect(replay.scenes.at(-1)!.eventIds.at(-1)).toBe(s.events.at(-1)!.id)
    // Activity: auth.ts read once and changed twice.
    expect(replay.files.get("src/auth/auth.ts")).toMatchObject({ activity: 9, readCount: 1, changeCount: 2, additions: 4, deletions: 2 })
    expect(replay.stats).toMatchObject({
      prompts: 1,
      filesRead: 4,
      filesChanged: 2,
      commands: 2,
      failedCommands: 1,
      checks: [{ kind: "tests", command: "pnpm test auth", outcome: "passed", runs: 2 }]
    })
  })

  it("a long pause starts a new chapter", () => {
    const s = build()
    s.prompt("Tidy up")
    s.change("a.ts")
    const late = s.events.length
    s.change("b.ts")
    for (const e of s.events.slice(late)) (e as { timestamp: string }).timestamp = "2026-09-01T12:00:00.000Z"
    expect(deriveReplay(session, s.events).chapters.map((c) => c.title)).toEqual(["Changed a.ts", "Changed b.ts"])
  })

  it("missing timestamps, tools and paths degrade gracefully", () => {
    const s = build()
    s.reply("Nothing to do.")
    for (const e of s.events) delete (e as { timestamp?: string }).timestamp
    const replay = deriveReplay({ ...session, projectPath: undefined } as unknown as Session, s.events)
    checkInvariants(replay)
    expect(replay.title).toBe("Untitled session")
    expect(replay.chapters.map((c) => c.title)).toEqual(["Replied without using tools"])
  })
})

describe("findings from the Replay audit (AUDIT.md)", () => {
  it("#1 a different check passing after a failure is not a fix", () => {
    const s = build()
    s.run("pnpm test", 1)
    s.change("a.ts")
    s.run("pnpm lint", 0)
    const replay = deriveReplay(session, s.events)
    const titles = replay.chapters.map((c) => c.title)
    expect(titles.some((t) => /fixed/i.test(t))).toBe(false)
    expect(titles).toEqual(["Ran tests → failed", "Changed a.ts"])
    expect(replay.chapters[1]!.summary).toBe("Changed 1 file, ran 1 command, the linter passed")
    expect(replay.summary).toContain("Still failing at its last run: tests.")
    expect(replay.summary).toContain("Passed at its last run: the linter.")
  })

  it("#1 a different test scope passing is not a fix either", () => {
    const s = build()
    s.run("pnpm test auth", 1)
    s.change("auth.ts")
    s.run("pnpm test billing", 0)
    expect(deriveReplay(session, s.events).chapters.map((c) => c.title).some((t) => /fixed/i.test(t))).toBe(false)
  })

  it("#1 an interrupted re-run is not a fix", () => {
    const s = build()
    s.run("pnpm test", 1)
    s.change("a.ts")
    s.run("pnpm test", "interrupted")
    const replay = deriveReplay(session, s.events)
    expect(replay.chapters.map((c) => [c.kind, c.title])).toEqual([
      ["debugging", "Changed code and re-ran failing tests; result unclear"]
    ])
  })

  it("#1 the same check failing again stays failing", () => {
    const s = build()
    s.run("pnpm test", 1)
    s.change("a.ts")
    s.run("pnpm test", 1)
    expect(deriveReplay(session, s.events).chapters.map((c) => c.title)).toEqual(["Changed code; tests still failing"])
  })

  it("#2 command results join by commandId without parent links", () => {
    const s = build()
    s.shell("pnpm test", "succeeded")
    const replay = deriveReplay(session, s.events)
    checkInvariants(replay)
    expect(replay.scenes.map((sc) => [sc.title, sc.eventIds.length])).toEqual([["Ran tests → passed", 2]])
    expect(replay.summary).toContain("Passed at its last run: tests.")
  })

  it("#3 a pipe or || after a check hides its result", () => {
    for (const command of ["pnpm test | tail -20", "pnpm test || true", "pnpm test; echo done"]) {
      const s = build()
      s.run(command, 0)
      expect(deriveReplay(session, s.events).scenes[0]!.title, command).toBe("Ran tests → outcome unknown")
    }
    const s = build()
    s.run("set -o pipefail; pnpm test | tail -20", 0)
    expect(deriveReplay(session, s.events).scenes[0]!.title).toBe("Ran tests → passed")
  })

  it("#4 changed lines that start with --- or +++ are counted and kept", () => {
    expect(diffStat("@@ -1 +1 @@\n---removed text\n+++added text\n")).toEqual({ additions: 1, deletions: 1 })
    const full = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n"
    expect(parseDiff(full).map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "ctx", "del", "add", "meta"])
    expect(diffStat("")).toEqual({ additions: 0, deletions: 0 })
    expect(diffStat("line one\nline two\n")).toEqual({ additions: 2, deletions: 0 })
    const twoHunks = "@@ -1 +1 @@\n-a\n+b\n@@ -9,2 +9,1 @@\n ctx\n-gone\n"
    expect(diffStat(twoHunks)).toEqual({ additions: 1, deletions: 2 })
  })

  it("#7 tool metadata that arrives in tool.updated is used", () => {
    const s = build()
    s.lateTool("edit", "edit file")
    const replay = deriveReplay(session, s.events)
    expect(replay.scenes.map((sc) => [sc.kind, sc.title])).toEqual([["change", "Tried to edit files (failed)"]])
    // The raw start event is left as recorded.
    expect(s.events[0]).toMatchObject({ type: "tool.started", kind: "other", name: "pending" })
  })

  it("#8 command counts and failures use the same population", () => {
    const s = build()
    s.run("cat missing.txt", 1)
    const replay = deriveReplay(session, s.events)
    expect(replay.stats).toMatchObject({ commands: 0, failedCommands: 0, inspections: 1, failedInspections: 1 })
    expect(replay.summary).toContain("had 1 inspection command fail")
    expect(replay.summary).not.toContain("No files or commands were recorded")
  })
})

describe("large sessions (AUDIT D)", () => {
  it("derives 10,000 events well within a second", () => {
    const s = build()
    for (let i = 0; s.events.length < 10_000; i++) {
      if (i % 40 === 0) s.prompt(`request ${i}`)
      if (i % 5 === 0) s.read(`src/mod${i % 23}/file${i % 311}.ts`)
      else if (i % 7 === 0) s.run(i % 14 === 0 ? "pnpm test" : "pnpm build", i % 28 === 0 ? 1 : 0)
      else s.change(`src/mod${i % 23}/file${i % 311}.ts`)
    }
    const start = performance.now()
    const replay = deriveReplay(session, s.events)
    // Measured at ~40 ms on a laptop; the bound only catches accidental quadratic work.
    expect(performance.now() - start).toBeLessThan(1000)
    checkInvariants(replay)
  })
})

describe("command classification", () => {
  it.each([
    ["pnpm test", "tests"],
    ["cd web && npm run build", "build"],
    ["npx tsc --noEmit", "typecheck"],
    ["pnpm check", "checks"],
    ["cargo clippy", "lint"],
    ["pnpm --filter @app/web test:unit", "tests"],
    ["python -m pytest -x", "tests"],
    ["uv run mypy src", "typecheck"],
    ["go test ./...", "tests"],
    ["make lint", "lint"],
    ["nix develop -c gleam test", "tests"],
    ["mix test --trace", "tests"],
    ["zig build test", "tests"],
    ["timeout 120 pnpm run typecheck", "typecheck"],
    ["node --test test/*.test.ts", "tests"],
    ["python3 -m unittest discover", "tests"],
    ["bundle exec rspec spec/models", "tests"],
    ["xcodebuild test -scheme App", "tests"],
    ["rake test", "tests"],
    ["./gradlew :wear:testDebugUnitTest", "tests"],
    ["./node_modules/.bin/tsc --noEmit", "typecheck"],
    ["nix build .#cto", "build"],
    ["nix flake check", "checks"],
    ["./node_modules/.bin/vite build", "build"],
    ["npx next build", "build"],
    ["npx astro check", "typecheck"]
  ])("%s is validation (%s)", (command, kind) => {
    expect(classifyCommand(command)).toMatchObject({ type: "validation", kind, exitReflectsCheck: true })
  })

  it("knows whether the recorded output belongs to the check", () => {
    expect(classifyCommand("pnpm test 2>&1 | tail -20")).toMatchObject({ outputIsCheck: true })
    expect(classifyCommand("cd web && pnpm test | grep -E 'pass|fail'")).toMatchObject({ outputIsCheck: true })
    expect(classifyCommand("gleam test | tail -1; nix build")).toMatchObject({ outputIsCheck: false })
    expect(classifyCommand("pnpm build && pnpm start")).toMatchObject({ outputIsCheck: false })
  })

  it("the same check keeps the same identity across redirections", () => {
    expect(classifyCommand("pnpm test auth 2>&1")).toMatchObject({ check: "pnpm test auth" })
    expect(classifyCommand("nix develop -c gleam build 2>&1 | tail -30")).toMatchObject({ check: "gleam build" })
    expect(classifyCommand("timeout 60 npx tsc --noEmit")).toMatchObject({ check: "tsc --noEmit" })
  })

  it.each(["ls -la", "cat README.md | head -20", "git diff HEAD~1", "rg foo src", "sed -n 1,20p a.ts"])("%s is read-only", (command) => {
    expect(classifyCommand(command).type).toBe("read")
  })

  it.each([
    "git commit -m 'fix failing test'",
    "echo hi > notes.md",
    "sed -i '' s/a/b/ file",
    "python3 - <<'EOF'\nprint('test build')\nEOF",
    "npm ci",
    "rm -rf build",
    "touch test",
    "mkdir -p tests/fixtures",
    "npm install jest",
    "gleam format src test",
    "pnpm run testimonials:sync",
    "nix develop"
  ])("%s is neither", (command) => {
    expect(classifyCommand(command).type).toBe("other")
  })
})
