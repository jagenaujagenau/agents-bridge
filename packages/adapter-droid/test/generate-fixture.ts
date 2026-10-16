/**
 * Writes the sanitized Factory Droid fixtures for the spec §63 scenario:
 *
 *   user asks to add a Usage section to README.md → agent reads README.md →
 *   edits it → runs `npm test` (fails) → creates docs/usage.md →
 *   runs `npm test` (passes) → replies.
 *
 * Plus one malformed line, one unknown record type, one injected `<system-reminder>`,
 * a decoy credentials file that must never be read, and a Task subagent session.
 * The shapes follow Droid CLI 0.242 (session format `version: 2`); no real history is copied.
 *
 * Run: node packages/adapter-droid/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const DROID_SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
export const DROID_SUBAGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

const defaultRoot = fileURLToPath(new URL("../../testing/fixtures/", import.meta.url))

export const generateDroidFixture = (fixturesRoot: string = defaultRoot): void => {
  const cwd = "/work/demo"
  const prompt = "Add a Usage section to README.md and make sure the tests pass."
  const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
  const t = (s: number) => `2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`
  const home = join(fixturesRoot, "droid")
  const factory = join(home, ".factory")
  const project = join(factory, "sessions", "-work-demo")
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const jsonl = (records: ReadonlyArray<unknown>) =>
    records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"

  rmSync(home, { recursive: true, force: true })

  let n = 0
  let parent: string | undefined
  const message = (s: number, role: "user" | "assistant", content: ReadonlyArray<object>, extra: object = {}) => {
    const id = `m${String(++n).padStart(3, "0")}-${role}`
    const record = {
      type: "message",
      id,
      ...(parent !== undefined ? { parentId: parent } : {}),
      timestamp: t(s),
      message: { role, content },
      ...extra
    }
    parent = id
    return record
  }
  const toolUse = (s: number, id: string, name: string, input: object) =>
    message(s, "assistant", [{ type: "tool_use", id, name, input }], { tokens: 1200 + s })
  const toolResult = (s: number, id: string, content: string, isError = false) =>
    message(s, "user", [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }])

  // A decoy: Droid keeps tokens here. The adapter never walks outside sessions/ and projects/.
  write(join(factory, "auth.json"), JSON.stringify({ accessToken: "sk-ant-FAKE0000000000000000000000000000", refreshToken: "FAKE" }))

  write(
    join(project, `${DROID_SESSION}.jsonl`),
    jsonl([
      { type: "session_start", id: DROID_SESSION, title: "Add README usage section", owner: "demo-user", version: 2, cwd },
      message(1, "user", [
        { type: "text", text: "<system-reminder>\nUser system info: darwin, cwd /work/demo\n</system-reminder>" },
        { type: "text", text: prompt }
      ]),
      message(2, "assistant", [
        { type: "thinking", thinking: "I should read the README first.", signature: "sig" },
        { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/demo/README.md" } }
      ], { tokens: 1100 }),
      toolResult(4, "toolu_read", "# Demo\nA demo project."),
      toolUse(5, "toolu_edit", "Edit", { file_path: "/work/demo/README.md", old_str: "A demo project.", new_str: "A demo project.\n\n## Usage\n\nRun `npm start`." }),
      toolResult(6, "toolu_edit", "The file /work/demo/README.md has been updated successfully."),
      "{\"type\":\"message\",\"id\":\"broken", // malformed
      toolUse(7, "toolu_test1", "Execute", { command: "npm test", riskLevel: "low", riskLevelReason: "Runs the test suite" }),
      toolResult(8, "toolu_test1", "1 failing: usage section missing example\n\n[Process exited with code 1]", true),
      { type: "future_record_type", id: "f1", timestamp: t(8), somethingNew: true }, // unknown
      toolUse(9, "toolu_create", "Create", { file_path: "/work/demo/docs/usage.md", content: "# Usage\n\nRun `npm start`.\n" }),
      toolResult(10, "toolu_create", "The file /work/demo/docs/usage.md has been created successfully."),
      toolUse(11, "toolu_test2", "Execute", { command: "npm test", riskLevel: "low" }),
      toolResult(12, "toolu_test2", "2 passing\n\n[Process exited with code 0]"),
      message(13, "assistant", [{ type: "text", text: reply }], { tokens: 1500 })
    ])
  )
  write(
    join(project, `${DROID_SESSION}.settings.json`),
    JSON.stringify({ model: "claude-opus-5", reasoningEffort: "medium", interactionMode: "auto", autonomyLevel: "low", tokenUsage: { inputTokens: 900, outputTokens: 120 } }, null, 2)
  )

  // A Task subagent: its own session file, linked to the caller by session_start.
  n = 0
  parent = undefined
  write(
    join(project, `${DROID_SUBAGENT}.jsonl`),
    jsonl([
      {
        type: "session_start",
        id: DROID_SUBAGENT,
        title: "Find TODO comments",
        owner: "demo-user",
        callingSessionId: DROID_SESSION,
        callingToolUseId: "toolu_task",
        version: 2,
        cwd
      },
      message(20, "user", [{ type: "text", text: "Find all TODO comments in src/." }]),
      toolUse(21, "toolu_grep", "Grep", { pattern: "TODO", path: "/work/demo/src" }),
      toolResult(22, "toolu_grep", "No matches found"),
      message(23, "assistant", [{ type: "text", text: "There are no TODO comments in src/." }]),
      { type: "agent_turn_outcome", turnId: "m001-user", reason: "completed", resultKind: "text" }
    ])
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) generateDroidFixture()
