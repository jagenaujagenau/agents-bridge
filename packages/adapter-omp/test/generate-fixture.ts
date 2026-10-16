/**
 * Writes the sanitized oh-my-pi fixtures into packages/testing/fixtures/omp. Nothing here comes
 * from a real session; the shapes follow @oh-my-pi/pi-coding-agent 18.11.1's session writer.
 *
 * - agent/sessions: the spec §63 scenario (prompt, read README.md, edit it, `npm test` fails,
 *   create docs/usage.md, `npm test` passes, reply) with one malformed line, one unknown entry type,
 *   one injected (developer) notice, late usage, and a subagent spawned by `task`.
 * - custom-sessions: a flat directory (OMP_CODING_AGENT_SESSION_DIR) with the remaining omp
 *   records: user `!`/`$` commands, file mentions, synthetic prompts, multi-file and AST edits,
 *   a todo plan, a background command and an abandoned branch.
 *
 * Run: node packages/adapter-omp/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const OMP_SESSION_ID = "dddddddd-dddd-7ddd-8ddd-dddddddddddd"
export const OMP_SUBAGENT_AGENT_ID = "TodoScout"
export const OMP_CUSTOM_SESSION_ID = "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee"

const root = fileURLToPath(new URL("../../testing/fixtures/omp/", import.meta.url))
const cwd = "/work/demo"
const prompt = "Add a Usage section to README.md and make sure the tests pass."
const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
const t = (s: number) => `2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`
const ms = (s: number) => Date.parse(t(s))

const write = (path: string, lines: ReadonlyArray<unknown>) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n")
}

/** omp's first line: a title slot padded to exactly 256 bytes, newline included. */
const titleSlot = (title: string, updatedAt: string) => {
  const unpadded = JSON.stringify({ type: "title", v: 1, title, source: "auto", updatedAt, pad: "" })
  return JSON.stringify({ type: "title", v: 1, title, source: "auto", updatedAt, pad: " ".repeat(255 - Buffer.byteLength(unpadded)) })
}

const runtime = { name: "omp", version: "18.11.1" }
const usage = (input: number, output: number, cacheRead: number, reasoningTokens?: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

/** Builds a chain of entries; `branch` moves the leaf back to an earlier entry. */
const tree = (prefix: string, model = "claude-sonnet-5") => {
  let n = 0
  let leaf: string | null = null
  const entry = (s: number, body: object, parentId: string | null = leaf) => {
    const id = `${prefix}${String(++n).padStart(7, "0")}`
    leaf = id
    return { id, parentId, timestamp: t(s), runtime, ...body }
  }
  const message = (s: number, message: object) => entry(s, { type: "message", message: { timestamp: ms(s), ...message } })
  const assistant = (s: number, content: ReadonlyArray<object>, stopReason = "toolUse") =>
    message(s, { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model, usage: usage(12, 9, 30, 5), stopReason })
  const result = (s: number, toolCallId: string, toolName: string, text: string, details?: object, isError = false) =>
    message(s, { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, ...(details ? { details } : {}) })
  return { entry, message, assistant, result, leaf: () => leaf, branch: (id: string) => (leaf = id) }
}

export const generate = () => {
  rmSync(root, { recursive: true, force: true })
  const dir = join(root, "agent", "sessions", "--work-demo--")
  const stem = `2026-09-01T10-00-00-000Z_${OMP_SESSION_ID}`
  const parentFile = `/home/user/.omp/agent/sessions/--work-demo--/${stem}.jsonl`

  // -------------------------------------------------------------------- scenario
  const m = tree("a")
  const records: Array<unknown> = [
    titleSlot("Add README usage section", t(15)),
    { type: "session", version: 3, id: OMP_SESSION_ID, timestamp: t(0), cwd },
    m.entry(0, { type: "model_change", model: "anthropic/claude-sonnet-5" }),
    m.entry(0, { type: "model_change", model: "anthropic/claude-haiku-5", role: "smol" }),
    m.entry(0, { type: "thinking_level_change", thinkingLevel: "medium", configured: "medium" }),
    m.entry(0, { type: "credential_pin", provider: "anthropic", hash: "0000000000000000000000000000000000000000000000000000000000000000" }),
    m.message(1, { role: "user", content: [{ type: "text", text: prompt }] }),
    m.message(1, { role: "developer", content: [{ type: "text", text: "<system-reminder>Today is 2026-09-01. Working directory: /work/demo</system-reminder>" }] }),
    m.assistant(2, [
      { type: "thinking", thinking: "I should read the README first.", thinkingSignature: "sig" },
      { type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "README.md" } }
    ]),
    m.result(4, "toolu_read", "read", "1#a3f0:# Demo\n2#9c1e:A demo project.", { resolvedPath: "/work/demo/README.md" }),
    m.assistant(5, [{
      type: "toolCall",
      id: "toolu_edit",
      name: "edit",
      arguments: { input: "*** Begin Patch\n[README.md#4B1D]\nPUT >2:\n+\n+## Usage\n+\n+Run `npm start`.\n*** End Patch" }
    }]),
    m.result(6, "toolu_edit", "edit", "Updated README.md", {
      diff: "  2 A demo project.\n+ 3 \n+ 4 ## Usage\n+ 5 \n+ 6 Run `npm start`.",
      firstChangedLine: 3,
      op: "update",
      path: "/work/demo/README.md",
      oldText: "# Demo\nA demo project.\n",
      newText: "# Demo\nA demo project.\n\n## Usage\n\nRun `npm start`.\n"
    }),
    "{\"type\":\"message\",\"id\":\"broken", // malformed
    m.assistant(7, [{ type: "toolCall", id: "toolu_test1", name: "bash", arguments: { command: "npm test" } }]),
    m.result(8, "toolu_test1", "bash", "1 failing: usage section missing example\n\nCommand exited with code 1", { wallTimeNoticeEmitted: false, timeoutSeconds: 300, exitCode: 1 }, true),
    m.entry(8, { type: "future_entry_type", something: true }),
    m.entry(8, { type: "ttsr_injection", injectedRules: ["no-console"] }),
    m.assistant(9, [{
      type: "toolCall",
      id: "toolu_task",
      name: "task",
      arguments: { agent: "explore", name: OMP_SUBAGENT_AGENT_ID, task: "Find all TODO comments in src/.", solutionSpace: "src/" }
    }]),
    m.result(9, "toolu_task", "task", "There are no TODO comments in src/.", { results: [{ id: OMP_SUBAGENT_AGENT_ID, agent: "explore", exitCode: 0 }] }),
    m.assistant(9, [{ type: "toolCall", id: "toolu_write", name: "write", arguments: { path: "docs/usage.md", content: "# Usage\n\nRun `npm start`.\n" } }]),
    m.result(10, "toolu_write", "write", "Successfully wrote 27 bytes to docs/usage.md", { resolvedPath: "/work/demo/docs/usage.md" }),
    m.assistant(11, [{ type: "toolCall", id: "toolu_test2", name: "bash", arguments: { command: "npm test" } }]),
    m.result(12, "toolu_test2", "bash", "2 passing", { wallTimeNoticeEmitted: false, timeoutSeconds: 300 })
  ]
  const replyEntry = m.assistant(13, [{ type: "text", text: reply }], "stop")
  records.push(replyEntry)
  const titleChange = m.entry(15, { type: "title_change", title: "Add README usage section", source: "auto", trigger: "first-turn" })
  records.push(titleChange)
  // Late usage: a cache warm-up started after the reply and finished after the title change moved the
  // leaf. It hangs off the reply; `activeLeafId` keeps the title change as the leaf.
  records.push(m.entry(16, {
    type: "model_usage",
    purpose: "cache-warm",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: usage(0, 1, 60),
    stopReason: "length",
    activeLeafId: titleChange.id
  }, replyEntry.id))
  write(join(dir, `${stem}.jsonl`), records)

  // -------------------------------------------------------------------- subagent
  const c = tree("b", "claude-haiku-5")
  write(join(dir, stem, `${OMP_SUBAGENT_AGENT_ID}.jsonl`), [
    titleSlot("", t(20)),
    { type: "session", version: 3, id: "dddddddd-dddd-7ddd-8ddd-000000000001", timestamp: t(20), cwd, parentSession: parentFile },
    c.entry(20, { type: "session_init", systemPrompt: ["You are a read-only explorer."], task: "Find all TODO comments in src/.", tools: ["grep", "read"], agent: "explore" }),
    c.entry(20, { type: "model_change", model: "anthropic/claude-haiku-5" }),
    c.message(20, { role: "user", content: "Find all TODO comments in src/." }),
    c.assistant(21, [{ type: "toolCall", id: "toolu_grep", name: "grep", arguments: { pattern: "TODO", path: "src" } }]),
    c.result(22, "toolu_grep", "grep", "No matches found"),
    c.assistant(23, [{ type: "text", text: "There are no TODO comments in src/." }], "stop")
  ])
  // Not sessions: an advisor transcript, a backup and the subagent's output.
  write(join(dir, stem, "__advisor.jsonl"), [{ type: "session", version: 3, id: "advisor", timestamp: t(20), cwd }])
  write(join(dir, stem, `${OMP_SUBAGENT_AGENT_ID}.bak.jsonl`), [{ type: "session", version: 3, id: "backup", timestamp: t(20), cwd }])
  writeFileSync(join(dir, stem, `${OMP_SUBAGENT_AGENT_ID}.md`), "There are no TODO comments in src/.\n")

  // -------------------------------------------------------------------- custom flat directory
  const x = tree("c")
  const custom: Array<unknown> = [
    titleSlot("Tidy the docs", t(41)),
    { type: "session", version: 3, id: OMP_CUSTOM_SESSION_ID, timestamp: t(40), cwd },
    x.message(40, { role: "bashExecution", command: "git status --short", output: " M README.md", exitCode: 0, cancelled: false, truncated: false }),
    x.message(41, { role: "pythonExecution", code: "print(1 / 0)", output: "ZeroDivisionError: division by zero", exitCode: 1, cancelled: false, truncated: false }),
    x.message(42, { role: "fileMention", files: [{ path: "docs/usage.md", content: "# Usage\n", lineCount: 1 }] }),
    x.message(42, { role: "hookMessage", customType: "reminder", content: "Remember the changelog.", display: true }),
    x.message(43, { role: "user", content: "Tidy the docs." })
  ]
  const kept = x.leaf()!
  custom.push(
    x.assistant(44, [{ type: "text", text: "abandoned answer" }], "stop"),
    x.entry(44, { type: "reset_boundary" })
  )
  x.branch(kept)
  custom.push(
    x.assistant(45, [
      { type: "redactedThinking", data: "opaque" },
      { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-sonnet-5" } },
      { type: "anthropicServerTool", block: { type: "server_tool_use", name: "web_search" } },
      { type: "toolCall", id: "toolu_multi", name: "edit", arguments: { input: "*** Begin Patch\n[docs/usage.md#1A2B]\nMV docs/guide.md\n[docs/old.md#3C4D]\nREM\n[docs/new.md#0000]\nPUT >$:\n+# New\n*** End Patch" } }
    ]),
    x.result(46, "toolu_multi", "edit", "Updated 3 files", {
      diff: "...",
      perFileResults: [
        { path: "/work/demo/docs/guide.md", sourcePath: "/work/demo/docs/usage.md", op: "update", move: "/work/demo/docs/guide.md", diff: "" },
        { path: "/work/demo/docs/old.md", op: "delete", diff: "- 1 # Old" },
        { path: "/work/demo/docs/new.md", op: "create", diff: "+ 1 # New" },
        { path: "/work/demo/docs/broken.md", op: "update", diff: "", isError: true, errorText: "stale tag" }
      ]
    }),
    x.assistant(47, [{ type: "toolCall", id: "toolu_ast", name: "ast_edit", arguments: { ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["src"] } }]),
    x.result(48, "toolu_ast", "ast_edit", "Applied 2 replacements in 1 file.", { applied: true, totalReplacements: 2, filesTouched: 1, filesSearched: 4, limitReached: false, fileReplacements: [{ path: "src/a.ts", count: 2 }] }),
    x.assistant(49, [{ type: "toolCall", id: "toolu_todo", name: "todo", arguments: { op: "init", list: [{ phase: "Docs", items: ["Rename the guide", "Drop old docs", "Check links"] }] } }]),
    x.result(50, "toolu_todo", "todo", "Todo list initialized.", {
      op: "init",
      phases: [{ name: "Docs", tasks: [{ content: "Rename the guide", status: "completed" }, { content: "Drop old docs", status: "in_progress" }, { content: "Check links", status: "abandoned" }] }]
    }),
    x.assistant(51, [
      { type: "toolCall", id: "toolu_sel", name: "read", arguments: { path: "src/a.ts:1-20" } },
      { type: "toolCall", id: "toolu_uri", name: "read", arguments: { path: "artifact://3" } },
      { type: "toolCall", id: "toolu_bg", name: "bash", arguments: { command: "npm run dev", async: true } },
      { type: "toolCall", id: "toolu_eval", name: "eval", arguments: { language: "py", code: "1 + 1" } }
    ]),
    x.result(52, "toolu_sel", "read", "1#aaaa:export const a = 1"),
    x.result(52, "toolu_uri", "read", "artifact contents"),
    x.result(52, "toolu_bg", "bash", "Started background job 1", { async: { state: "running", jobId: "1", type: "bash" } }),
    x.result(52, "toolu_eval", "eval", "2"),
    x.message(53, { role: "user", content: "Continue.", synthetic: true }),
    x.assistant(54, [{ type: "text", text: "The docs are tidy." }], "stop")
  )
  write(join(root, "custom-sessions", `2026-09-01T10-00-40-000Z_${OMP_CUSTOM_SESSION_ID}.jsonl`), custom)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate()
  console.log("generated omp")
}
