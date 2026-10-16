/**
 * Regenerates the sanitized Amp fixtures for the spec §63 scenario:
 *
 *   user asks to add a Usage section to README.md → agent reads README.md →
 *   edits it → runs `npm test` (fails) → creates docs/usage.md →
 *   runs `npm test` (passes) → replies.
 *
 * A thread is one JSON document, so the damaged records are one malformed message and one
 * unknown content block type. The scenario also carries a hidden (injected) user block, a
 * todo_write plan and a Task subagent. A second thread, saved as an `amp threads export`,
 * is a handoff from the first with `M-` message IDs and a user shell command.
 *
 * Nothing here is copied from real history. Run: node packages/adapter-amp/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../testing/fixtures/amp/", import.meta.url))
const cwd = "/work/demo"
const prompt = "Add a Usage section to README.md and make sure the tests pass."
const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
const t = (s: number) => `2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`
const ms = (s: number) => Date.parse(t(s))

export const MAIN_THREAD = "T-dddddddd-dddd-4ddd-8ddd-dddddddddddd"
export const EXPORTED_THREAD = "T-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const model = "claude-opus-4-6"
const usage = (s: number, input: number, output: number, cacheCreation: number, cacheRead: number) => ({
  model,
  maxInputTokens: 168000,
  inputTokens: input,
  outputTokens: output,
  cacheCreationInputTokens: cacheCreation,
  cacheReadInputTokens: cacheRead,
  totalInputTokens: input + cacheCreation + cacheRead,
  timestamp: t(s)
})
const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input, complete: true })
const done = (toolUseID: string, result: unknown, extra: object = {}) => ({
  type: "tool_result",
  toolUseID,
  run: { status: "done", result, ...extra }
})

export const generate = () => {
  rmSync(root, { recursive: true, force: true })
  const env = (s: number) => ({
    initial: {
      trees: [{ displayName: "demo", uri: `file://${cwd}` }],
      platform: { os: "darwin", client: "CLI", clientVersion: "0.0.1774959077-ga71644", clientType: "cli" },
      tags: [`model:${model}`]
    },
    updatedAt: t(s)
  })

  let id = 0
  const user = (s: number | undefined, content: ReadonlyArray<object>) => ({
    role: "user",
    messageId: id++,
    content,
    ...(s !== undefined ? { meta: { sentAt: ms(s) } } : {})
  })
  const assistant = (s: number, content: ReadonlyArray<object>, stopReason = "tool_use", extra: object = {}) => ({
    role: "assistant",
    messageId: id++,
    content,
    state: { type: "complete", stopReason },
    usage: usage(s, 3, 40, 20, 100 + s),
    ...extra
  })

  const messages = [
    user(1, [
      { type: "text", text: prompt },
      { type: "text", text: "The user has the following files open: README.md", hidden: true }
    ]),
    assistant(2, [
      { type: "thinking", thinking: "I should read the README first.", signature: "sig" },
      toolUse("toolu_read", "Read", { path: `${cwd}/README.md` }),
      toolUse("toolu_todo", "todo_write", {
        todos: [
          { id: "1", content: "Add a Usage section to README.md", status: "in-progress", priority: "high" },
          { id: "2", content: "Make the tests pass", status: "todo", priority: "medium" }
        ]
      })
    ]),
    user(undefined, [
      done("toolu_read", { absolutePath: `${cwd}/README.md`, content: "1: # Demo\n2: A demo project." }),
      done("toolu_todo", "Updated the TODO list.")
    ]),
    assistant(4, [
      toolUse("toolu_edit", "edit_file", { path: `${cwd}/README.md`, old_str: "A demo project.", new_str: "A demo project.\n\n## Usage\n\nRun `npm start`." })
    ]),
    user(undefined, [
      done("toolu_edit", {
        diff: "```diff\n@@ -1,2 +1,6 @@\n # Demo\n A demo project.\n+\n+## Usage\n+\n+Run `npm start`.\n```",
        lineRange: [2, 6]
      })
    ]),
    // Malformed: content must be a list of blocks.
    { role: "assistant", messageId: id++, content: "not-a-list", state: { type: "complete", stopReason: "tool_use" } },
    assistant(6, [
      toolUse("toolu_test1", "Bash", { cmd: "npm test", cwd }),
      // A block type this adapter does not know.
      { type: "future_block_type", payload: "?" }
    ]),
    user(undefined, [done("toolu_test1", { output: "1 failing: usage section missing example", exitCode: 1 })]),
    assistant(8, [toolUse("toolu_write", "create_file", { path: `${cwd}/docs/usage.md`, content: "# Usage\n" })]),
    user(undefined, [done("toolu_write", `Successfully created file ${cwd}/docs/usage.md`)]),
    assistant(9, [toolUse("toolu_task", "Task", { description: "Check docs links", prompt: "Check that every link in docs/usage.md resolves." })]),
    user(undefined, [
      done("toolu_task", "All links in docs/usage.md resolve.", {
        progress: [{
          message: "Checking links in docs/usage.md",
          tool_uses: [{
            id: "toolu_sub_read",
            tool_name: "Read",
            status: "done",
            input: { path: `${cwd}/docs/usage.md` },
            result: { absolutePath: `${cwd}/docs/usage.md`, content: "1: # Usage" }
          }]
        }]
      })
    ]),
    assistant(11, [toolUse("toolu_test2", "Bash", { cmd: "npm test", cwd })]),
    user(undefined, [done("toolu_test2", { output: "2 passing", exitCode: 0 })]),
    assistant(13, [{ type: "text", text: reply }], "end_turn", { turnElapsedMs: 12000 })
  ]

  const main = {
    v: 57,
    id: MAIN_THREAD,
    created: ms(0),
    messages,
    nextMessageId: id,
    title: "Add README usage section",
    agentMode: "smart",
    env: env(0),
    relationships: [{ threadID: EXPORTED_THREAD, type: "handoff", role: "parent", createdAt: ms(20) }],
    "~debug": { lastInferenceUsage: usage(13, 3, 40, 20, 113) }
  }
  const threads = join(root, "data", "threads")
  write(join(threads, `${MAIN_THREAD}.json`), JSON.stringify(main, null, 2))
  // An in-flight rewrite: never a session.
  write(join(threads, `${MAIN_THREAD}.json.amptmp`), "{\n  \"v\": 58,\n")
  // Files beside the thread store that must never be read.
  write(join(root, "data", "secrets.json"), JSON.stringify({ "apiKey@https://ampcode.com/": "decoy-never-read" }, null, 2))
  write(join(root, "data", "history.jsonl"), JSON.stringify({ text: "decoy-never-read" }) + "\n")

  const exported = {
    v: 6,
    id: EXPORTED_THREAD,
    created: ms(20),
    messages: [
      {
        role: "info",
        messageId: "M-0000000000000000000001",
        content: [{
          type: "manual_bash_invocation",
          args: { cmd: "git", args: ["status", "--short"], cwd },
          toolRun: { status: "done", result: { output: " M README.md\n?? docs/", exitCode: 0 } }
        }],
        createdAt: t(21)
      },
      {
        role: "user",
        messageId: "M-0000000000000000000002",
        content: [{ type: "text", text: "Summarize what changed in the README." }],
        createdAt: t(22)
      },
      {
        role: "assistant",
        messageId: "M-0000000000000000000003",
        content: [{ type: "text", text: "README.md gained a Usage section; docs/usage.md is new." }],
        state: { type: "complete", stopReason: "end_turn" },
        usage: { model: "gpt-5.5", maxInputTokens: 272000, inputTokens: 0, outputTokens: 30, cacheCreationInputTokens: 50, cacheReadInputTokens: 200, totalInputTokens: 250, timestamp: t(24) },
        createdAt: t(24)
      }
    ],
    title: "Summarize README change",
    env: env(20),
    relationships: [{ threadID: MAIN_THREAD, type: "handoff", role: "child", createdAt: ms(20) }]
  }
  write(join(root, "exports", "readme-handoff.json"), JSON.stringify(exported, null, 2) + "\n")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate()
  console.log(`generated amp fixtures in ${root}`)
}
