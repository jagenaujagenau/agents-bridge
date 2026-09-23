import { NodeBridge } from "@agentbridge/platform-node"
import { fixtureBridgeOptions, relativeTo, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Replay, replaySession } from "../src/index.ts"

const layer = NodeBridge.layer(fixtureBridgeOptions)

/** What a user sees, independent of how each harness phrased its tool calls. */
const visible = (replay: Replay, projectPath: string) => ({
  title: replay.title,
  panes: replay.panes,
  conversation: replay.conversation.filter((e) => e.role === "user" || e.role === "agent").map((e) => [e.role, e.text]),
  edits: replay.files.filter((f) => f.change !== "read").map((f) => [f.change, relativeTo(projectPath, f.path)]),
  reads: replay.files.filter((f) => f.change === "read").map((f) => relativeTo(projectPath, f.path)),
  tests: replay.terminal.filter((t) => t.command === "npm test").map((t) => t.outcome),
  failedTools: replay.tools.filter((t) => t.status === "failed").length
})

describe("one Replay consumer, two harnesses (spec §94)", () => {
  it.effect("renders Claude Code and Codex sessions identically", () =>
    Effect.gen(function*() {
      const claude = yield* replaySession(scenario.claude)
      const codex = yield* replaySession(scenario.codex)
      expect(visible(codex, "/work/demo")).toEqual(visible(claude, "/work/demo"))
      expect(visible(claude, "/work/demo")).toMatchObject({
        title: "Add README usage section",
        panes: ["conversation", "terminal", "files", "tools", "reasoning"],
        edits: [["changed", "README.md"], ["created", "docs/usage.md"]],
        reads: ["README.md"],
        tests: ["failed", "succeeded"],
        failedTools: 1
      })
    }).pipe(Effect.provide(layer)))

  it.effect("subagent replays know their parent", () =>
    Effect.gen(function*() {
      expect((yield* replaySession(scenario.claudeSubagent)).subagentOf).toBe(scenario.claude)
      expect((yield* replaySession(scenario.codexSubagent)).subagentOf).toBe(scenario.codex)
    }).pipe(Effect.provide(layer)))
})

describe("architectural test (spec §91)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const consumerSources = [
    ...readdirSync(`${root}examples/replay/src`).map((f) => `examples/replay/src/${f}`),
    ...readdirSync(`${root}packages/cli/src`).map((f) => `packages/cli/src/${f}`),
    "packages/testing/src/projection.ts"
  ]
  const forbidden = [
    /claude/i,
    /codex/i,
    /harness\.id/,
    /source\.provider/,
    /\bBash\b/,
    /exec_command/,
    /apply_patch/,
    /\bprovider\s*===/,
    /tool_use/
  ]

  /** Comments may explain the rule; only code must obey it. */
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it.each(consumerSources)("%s has no provider-specific logic", (file) => {
    const source = code(readFileSync(`${root}${file}`, "utf8"))
    for (const pattern of forbidden) expect(source, `${file} matches ${pattern}`).not.toMatch(pattern)
  })

  it("consumers do not depend on adapter packages", () => {
    for (const pkg of ["examples/replay/package.json", "packages/core/package.json", "packages/schema/package.json"]) {
      const manifest = JSON.parse(readFileSync(`${root}${pkg}`, "utf8")) as { dependencies?: Record<string, string> }
      expect(Object.keys(manifest.dependencies ?? {}).filter((d) => d.includes("adapter-")), pkg).toEqual([])
    }
  })

  it("core never imports a specific harness", () => {
    for (const file of readdirSync(`${root}packages/core/src`)) {
      const source = code(readFileSync(`${root}packages/core/src/${file}`, "utf8"))
      expect(source, file).not.toMatch(/adapter-|claude|codex/i)
    }
  })
})
