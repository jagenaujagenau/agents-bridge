/**
 * Writes the sanitized Crush fixtures for the spec §63 scenario:
 *
 *   user asks to add a Usage section to README.md → agent reads README.md →
 *   edits it → runs `npm test` (fails) → creates docs/usage.md →
 *   runs `npm test` (passes) → replies.
 *
 * Layout under packages/testing/fixtures/crush/:
 *
 *   global/projects.json            Crush's project registry (CRUSH_GLOBAL_DATA points here)
 *   global/crush.json               decoy provider config with an API key, never read
 *   projects/demo/.crush/crush.db   the project database (sessions, messages, files, read_files)
 *
 * The database follows Crush's goose migrations up to 20260928000001 and the part encoding
 * of internal/message (`[{"type": …, "data": …}]`). It also holds one malformed message row,
 * one unknown part type, one hidden (generated) user continuation, an agent-tool sub-session
 * (`<message ID>$$<tool call ID>`), and a decoy secret in the `files` table, which the adapter
 * never queries. Nothing is copied from real history.
 *
 * The registry's `data_dir` is relative so the fixture is machine independent; Crush itself
 * always writes absolute paths. Generation is deterministic (fixed IDs and times, VACUUM).
 *
 * Run: node packages/adapter-crush/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

export const CRUSH_SESSION = "c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7"
/** The assistant message that called the `agent` tool, and the call. */
export const CRUSH_AGENT_MESSAGE = "c7000000-0000-4000-8000-000000000011"
export const CRUSH_SUBAGENT = `${CRUSH_AGENT_MESSAGE}$$call_agent`

/** The scenario as canonical session IDs. */
export const crushScenario = {
  crush: `crush:${CRUSH_SESSION}`,
  crushSubagent: `crush:${CRUSH_SUBAGENT}`
} as const

const defaultRoot = fileURLToPath(new URL("../../testing/fixtures/", import.meta.url))

export const generate = (fixturesRoot: string = defaultRoot): void => {
  const cwd = "/work/demo"
  const prompt = "Add a Usage section to README.md and make sure the tests pass."
  const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
  const base = Date.parse("2026-09-01T10:00:00.000Z") / 1000
  const s = (n: number) => base + n
  const ms = (n: number) => s(n) * 1000
  const model = "claude-opus-5"
  const provider = "anthropic"

  const home = join(fixturesRoot, "crush")
  const global = join(home, "global")
  const dataDir = join(home, "projects", "demo", ".crush")
  rmSync(home, { recursive: true, force: true })
  mkdirSync(global, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  writeFileSync(
    join(global, "projects.json"),
    JSON.stringify(
      { projects: [{ path: cwd, data_dir: "../projects/demo/.crush", last_accessed: "2026-09-01T10:00:00Z" }] },
      null,
      2
    )
  )
  // A decoy: Crush writes provider overrides (API keys included) here. Bridge never reads it.
  writeFileSync(
    join(global, "crush.json"),
    JSON.stringify({ providers: { anthropic: { api_key: "sk-ant-FAKE0000000000000000000000000000" } } }, null, 2)
  )

  const db = new DatabaseSync(join(dataDir, "crush.db"))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0.0,
      updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      summary_message_id TEXT, todos TEXT, channel TEXT);
    CREATE TABLE files (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(path, session_id, version));
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]',
      model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
      provider TEXT, is_summary_message INTEGER DEFAULT 0 NOT NULL,
      prism_model_id TEXT, prism_model_name TEXT, prism_hypercredit_savings REAL, prism_dollar_savings REAL);
    CREATE TABLE read_files (
      session_id TEXT NOT NULL, path TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (path, session_id));
    CREATE TABLE mcp_disabled_servers (name TEXT PRIMARY KEY);
    CREATE TABLE mcp_enabled_servers (name TEXT PRIMARY KEY);
    CREATE INDEX idx_messages_session_id ON messages (session_id);
    CREATE INDEX idx_messages_created_at ON messages (created_at);
    CREATE INDEX idx_sessions_created_at ON sessions (created_at);
    CREATE INDEX idx_messages_role_created_at ON messages (role, created_at);
  `)

  const insertSession = db.prepare(
    "INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  insertSession.run(CRUSH_SESSION, null, "Add README usage section", 16, 5200, 640, 0.042, s(15), s(1))
  insertSession.run(CRUSH_SUBAGENT, CRUSH_SESSION, "New Agent Session", 4, 900, 60, 0.004, s(12), s(11))

  // The decoy secret: `files` keeps full snapshots of touched files, so it can hold anything.
  db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, 0, ?, ?)").run(
    "f-env",
    CRUSH_SESSION,
    `${cwd}/.env`,
    "ANTHROPIC_API_KEY=sk-ant-FAKE0000000000000000000000000000\n",
    s(4),
    s(4)
  )
  db.prepare("INSERT INTO read_files VALUES (?, ?, ?)").run(CRUSH_SESSION, `${cwd}/README.md`, s(3))

  const insertMessage = db.prepare(
    "INSERT INTO messages (id, session_id, role, parts, model, created_at, updated_at, finished_at, provider, is_summary_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
  )
  let n = 0
  const id = () => `c7000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
  const finish = (reason: string, at: number, message?: string) =>
    ({ type: "finish", data: { reason, time: at, ...(message !== undefined ? { message } : {}) } })
  const stop = finish("stop", 0)
  const message = (
    session: string,
    role: "user" | "assistant" | "tool",
    at: number,
    parts: ReadonlyArray<object> | string,
    messageId = id()
  ) => {
    const assistant = role === "assistant"
    const done = typeof parts === "string"
      ? null
      : (parts.find((p) => (p as { type?: string }).type === "finish") as { data: { time: number } } | undefined)?.data.time ?? null
    insertMessage.run(
      messageId,
      session,
      role,
      typeof parts === "string" ? parts : JSON.stringify(parts),
      assistant ? model : "",
      at,
      at,
      done,
      assistant ? provider : null
    )
  }
  const call = (callId: string, name: string, input: object) => ({
    type: "tool_call",
    data: { id: callId, name, input: JSON.stringify(input), provider_executed: false, finished: true }
  })
  const result = (callId: string, name: string, content: string, metadata?: object, isError = false) => ({
    type: "tool_result",
    data: {
      tool_call_id: callId,
      name,
      content,
      data: "",
      mime_type: "",
      metadata: metadata === undefined ? "" : JSON.stringify(metadata),
      is_error: isError
    }
  })
  const bash = (start: number, output: string, description: string) => ({
    start_time: ms(start),
    end_time: ms(start) + 120,
    output,
    description,
    working_directory: cwd
  })

  const failing = "> demo@1.0.0 test\n> node --test\n\n1 failing: usage section missing example\n\nexit status 1\nExit code 1"
  const passing = "> demo@1.0.0 test\n> node --test\n\n2 passing"

  message(CRUSH_SESSION, "user", s(1), [{ type: "text", data: { text: prompt } }, stop])
  message(CRUSH_SESSION, "assistant", s(2), [
    {
      type: "reasoning",
      data: { thinking: "I should read the README first.", signature: "sig", thought_signature: "", tool_id: "", responses_data: null, started_at: s(2), finished_at: s(2) }
    },
    call("call_view", "view", { file_path: `${cwd}/README.md` }),
    finish("tool_use", s(3))
  ])
  message(CRUSH_SESSION, "tool", s(3), [
    result("call_view", "view", "<file>\n     1|# Demo\n     2|A demo project.\n</file>\n", {
      file_path: `${cwd}/README.md`,
      content: "# Demo\nA demo project.\n"
    }),
    stop
  ])
  message(CRUSH_SESSION, "assistant", s(5), [
    call("call_edit", "edit", { file_path: `${cwd}/README.md`, old_string: "A demo project.", new_string: "A demo project.\n\n## Usage\n\nRun `npm start`." }),
    finish("tool_use", s(5))
  ])
  message(CRUSH_SESSION, "tool", s(6), [
    result("call_edit", "edit", `<result>\nContent replaced in file: ${cwd}/README.md\n</result>\n`, { additions: 4, removals: 0 }),
    stop
  ])
  message(CRUSH_SESSION, "assistant", s(7), [call("call_test1", "bash", { command: "npm test", description: "Run tests" }), finish("tool_use", s(7))])
  message(CRUSH_SESSION, "assistant", s(7), "[{\"type\":\"text\",\"data\":{\"text\":") // malformed row
  message(CRUSH_SESSION, "tool", s(8), [
    result("call_test1", "bash", `${failing}\n\n<cwd>${cwd}</cwd>`, bash(7, failing, "Run tests")),
    stop
  ])
  message(CRUSH_SESSION, "assistant", s(9), [
    call("call_write", "write", { file_path: `${cwd}/docs/usage.md`, content: "# Usage\n\nRun `npm start`.\n" }),
    { type: "future_part", data: { somethingNew: true } }, // unknown part type
    finish("tool_use", s(9))
  ])
  message(CRUSH_SESSION, "tool", s(10), [
    result("call_write", "write", `<result>\nFile successfully written: ${cwd}/docs/usage.md\n</result>\n`, {
      diff: "--- a/work/demo/docs/usage.md\n+++ b/work/demo/docs/usage.md\n@@ -0,0 +1,3 @@\n+# Usage\n+\n+Run `npm start`.\n",
      additions: 3,
      removals: 0
    }),
    stop
  ])
  // Two calls in one step: the tests again, and an agent-tool sub-session.
  message(
    CRUSH_SESSION,
    "assistant",
    s(11),
    [
      call("call_test2", "bash", { command: "npm test", description: "Run tests again" }),
      call("call_agent", "agent", { prompt: "Find all TODO comments in src/." }),
      finish("tool_use", s(11))
    ],
    CRUSH_AGENT_MESSAGE
  )

  // The sub-session runs while the parent waits for the agent tool's result.
  n = 100
  message(CRUSH_SUBAGENT, "user", s(11), [{ type: "text", data: { text: "Find all TODO comments in src/." } }, stop])
  message(CRUSH_SUBAGENT, "assistant", s(11), [call("call_grep", "grep", { pattern: "TODO", path: `${cwd}/src` }), finish("tool_use", s(11))])
  message(CRUSH_SUBAGENT, "tool", s(12), [result("call_grep", "grep", "No files found", { number_of_matches: 0, truncated: false }), stop])
  message(CRUSH_SUBAGENT, "assistant", s(12), [{ type: "text", data: { text: "There are no TODO comments in src/." } }, finish("end_turn", s(12))])

  n = 11
  message(CRUSH_SESSION, "tool", s(12), [result("call_test2", "bash", `${passing}\n\n<cwd>${cwd}</cwd>`, bash(11, passing, "Run tests again")), stop])
  message(CRUSH_SESSION, "tool", s(12), [result("call_agent", "agent", "There are no TODO comments in src/."), stop])
  message(CRUSH_SESSION, "assistant", s(13), [{ type: "text", data: { text: reply } }, finish("end_turn", s(13))])
  // A generated continuation (plan mode's "Implement the plan."), cancelled at once.
  message(CRUSH_SESSION, "user", s(14), [{ type: "text", data: { text: "Implement the plan.", hidden: true } }, stop])
  message(CRUSH_SESSION, "assistant", s(15), [finish("canceled", s(15), "User canceled request")])

  db.exec("VACUUM")
  db.close()
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) generate()
