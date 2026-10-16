/**
 * Writes the sanitized Goose fixtures for the spec §63 scenario:
 *
 *   user asks to add a Usage section to README.md → agent reads README.md →
 *   edits it → runs `npm test` (fails) → creates docs/usage.md →
 *   runs `npm test` (passes) → replies.
 *
 * Layout follows `GOOSE_PATH_ROOT=<root>`: `<root>/data/sessions/sessions.db` (schema version 17,
 * Goose 1.55) plus legacy `<root>/data/sessions/<id>.jsonl` files (Goose < 1.10).
 *
 * - the scenario session (ACP client with file reads; platform `shell` with recorded exit codes),
 *   with one malformed row, one unknown content block and one injected `<turn-context>` message;
 * - a `sub_agent` session linked by `parent_session_id`;
 * - a `hidden` internal session that must not be listed;
 * - a legacy JSONL session (the `developer__text_editor` / `developer__shell` MCP tools);
 * - a legacy JSONL file Goose already imported into the database (listed once, from the database);
 * - decoy secrets in `extension_data`, `model_config_json`, `recipe_json`,
 *   `user_recipe_values_json`, `config/config.yaml` and `config/secrets.yaml`, never read.
 *
 * No real history is copied. Run: node packages/adapter-goose/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

export const GOOSE_SESSION = "20260901_1"
export const GOOSE_SUBAGENT = "20260901_2"
export const GOOSE_HIDDEN = "20260901_3"
export const GOOSE_LEGACY = "20250611_090000"
export const GOOSE_IMPORTED = "20250520_080000"

/** Session IDs as Bridge exposes them. */
export const gooseScenario = {
  goose: `goose:${GOOSE_SESSION}`,
  gooseSubagent: `goose:${GOOSE_SUBAGENT}`,
  gooseLegacy: `goose:${GOOSE_LEGACY}`,
  gooseImported: `goose:${GOOSE_IMPORTED}`
} as const

const defaultRoot = fileURLToPath(new URL("../../testing/fixtures/", import.meta.url))

/** `GOOSE_PATH_ROOT` for the fixtures. */
export const gooseFixtureRoot = (fixturesRoot: string = defaultRoot) => join(fixturesRoot, "goose")

const FAKE_ANTHROPIC = "sk-ant-FAKE0000000000000000000000000000"
const FAKE_GITHUB = "ghp_FAKE000000000000000000000000000000000"

export const generate = (fixturesRoot: string = defaultRoot): void => {
  const cwd = "/work/demo"
  const prompt = "Add a Usage section to README.md and make sure the tests pass."
  const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
  const sec = (s: number) => Date.parse(`2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`) / 1000
  const sqlTime = (s: number) => `2026-09-01 10:00:${String(s).padStart(2, "0")}`

  const root = gooseFixtureRoot(fixturesRoot)
  const sessionsDir = join(root, "data", "sessions")
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const jsonl = (records: ReadonlyArray<unknown>) => records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"

  rmSync(root, { recursive: true, force: true })
  mkdirSync(sessionsDir, { recursive: true })

  // Decoys: Goose keeps provider keys here (or in the OS keyring). The adapter reads neither.
  write(join(root, "config", "config.yaml"), "GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-opus-5\n")
  write(join(root, "config", "secrets.yaml"), `ANTHROPIC_API_KEY: ${FAKE_ANTHROPIC}\nGITHUB_PERSONAL_ACCESS_TOKEN: ${FAKE_GITHUB}\n`)

  const db = new DatabaseSync(join(sessionsDir, "sessions.db"))
  // The schema Goose 1.55 creates (`SessionStorage::create_schema`), minus provider inventory tables.
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO schema_version (version, applied_at) VALUES (17, '2026-08-01 09:00:00');
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      user_set_name BOOLEAN DEFAULT FALSE, session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      extension_data TEXT DEFAULT '{}', total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, accumulated_total_tokens INTEGER,
      accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
      accumulated_cache_write_tokens INTEGER, accumulated_cost REAL, schedule_id TEXT, recipe_json TEXT,
      user_recipe_values_json TEXT, provider_name TEXT, model_config_json TEXT, goose_mode TEXT NOT NULL DEFAULT 'auto',
      archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT, system_prompt_override TEXT,
      system_prompt_extras_json TEXT, container_id TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT
    );
    CREATE TABLE usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      created_timestamp INTEGER NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0
    );
    CREATE INDEX idx_messages_session ON messages(session_id);
    CREATE INDEX idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX idx_messages_message_id ON messages(message_id);
    CREATE INDEX idx_messages_session_created ON messages(session_id, created_timestamp, id);
    CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX idx_sessions_type ON sessions(session_type);
    CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX idx_usage_ledger_session ON usage_ledger(session_id);
  `)

  const extensionData = JSON.stringify({
    "enabled_extensions.v0": {
      extensions: [{ type: "stdio", name: "github", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envs: { GITHUB_PERSONAL_ACCESS_TOKEN: FAKE_GITHUB } }]
    }
  })
  const modelConfig = JSON.stringify({
    model_name: "claude-opus-5",
    context_limit: 200000,
    request_headers: { "x-api-key": FAKE_ANTHROPIC }
  })
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, name, description, user_set_name, session_type, working_dir, created_at, updated_at,
      extension_data, accumulated_input_tokens, accumulated_output_tokens, accumulated_total_tokens, recipe_json,
      user_recipe_values_json, provider_name, model_config_json, goose_mode, parent_session_id)
    VALUES (?, ?, '', 0, ?, ?, ?, ?, ?, 4200, 380, 4580, ?, ?, ?, ?, 'auto', ?)`)
  const session = (id: string, name: string, type: string, workingDir: string, created: string, updated: string, extra: { parent?: string; recipe?: string } = {}) =>
    insertSession.run(
      id, name, type, workingDir, created, updated, extensionData,
      extra.recipe ?? null, extra.recipe !== undefined ? JSON.stringify({ token: FAKE_GITHUB }) : null,
      "anthropic", modelConfig, extra.parent ?? null
    )

  session(GOOSE_SESSION, "Add README usage section", "acp", cwd, sqlTime(0), sqlTime(13))
  session(GOOSE_SUBAGENT, "Delegated task", "sub_agent", cwd, sqlTime(20), sqlTime(23), {
    parent: GOOSE_SESSION,
    recipe: JSON.stringify({ version: "1.0.0", title: "Delegated task", prompt: "Find all TODO comments in src/.", parameters: [] })
  })
  session(GOOSE_HIDDEN, "", "hidden", cwd, sqlTime(14), sqlTime(14))
  session(GOOSE_IMPORTED, "Say hello", "user", "/work/old", "2025-05-20T08:00:00Z", "2025-05-20T08:00:05Z")

  const insertMessage = db.prepare(
    "INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
  let n = 0
  const visible = { userVisible: true, agentVisible: true }
  const message = (session: string, role: "user" | "assistant", s: number, content: ReadonlyArray<object> | string, metadata: object = visible) => {
    const id = `msg_${session}_${String(++n).padStart(4, "0")}`
    insertMessage.run(id, session, role, typeof content === "string" ? content : JSON.stringify(content), sec(s), sqlTime(s), JSON.stringify(metadata))
  }
  const model = { inference: { provider: "anthropic", requestedModel: "claude-opus-5", resolvedModel: "claude-opus-5-20260815" } }
  const usage = (input: number, output: number, cacheRead: number) => ({
    ...visible,
    ...model,
    usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, elapsedMs: 900 }
  })
  const call = (id: string, name: string, args: object) => ({
    type: "toolRequest",
    id,
    toolCall: { status: "success", value: { name, arguments: args } },
    _meta: { "goose.toolSummary.title": name }
  })
  const result = (id: string, text: string, extra: { isError?: boolean; structuredContent?: object } = {}) => ({
    type: "toolResponse",
    id,
    toolResult: {
      status: "success",
      value: { content: [{ type: "text", text, annotations: { priority: 0 } }], isError: extra.isError ?? false, ...(extra.structuredContent ? { structuredContent: extra.structuredContent } : {}) }
    }
  })

  // ------------------------------------------------------------------ scenario
  message(GOOSE_SESSION, "user", 1, [{ type: "text", text: prompt }])
  message(GOOSE_SESSION, "user", 1, [{
    type: "text",
    text: `<turn-context>\n<current-time>2026-09-01 10:00:00 +00:00</current-time>\n<working-directory>${cwd}</working-directory>\n</turn-context>`
  }], { userVisible: false, agentVisible: true, turnContext: true })
  message(GOOSE_SESSION, "assistant", 2, [
    { type: "thinking", thinking: "I should read the README first.", signature: "sig" },
    call("toolu_read", "read", { path: "/work/demo/README.md" })
  ], usage(1200, 80, 1000))
  message(GOOSE_SESSION, "user", 3, [result("toolu_read", "# Demo\nA demo project.\n")])
  message(GOOSE_SESSION, "assistant", 5, [
    call("toolu_edit", "edit", { path: "/work/demo/README.md", before: "A demo project.", after: "A demo project.\n\n## Usage\n\nRun `npm start`." })
  ], usage(1350, 90, 1200))
  message(GOOSE_SESSION, "user", 6, [result("toolu_edit", "Edited /work/demo/README.md (1 lines -> 5 lines)")])
  message(GOOSE_SESSION, "user", 6, "[{\"type\":\"text\",\"text\":") // malformed
  message(GOOSE_SESSION, "assistant", 7, [
    call("toolu_test1", "shell", { command: "npm test" }),
    { type: "futureBlock", something: true } // unknown
  ], usage(1500, 40, 1300))
  message(GOOSE_SESSION, "user", 8, [result("toolu_test1", "1 failing: usage section missing example\n\nCommand exited with code 1", {
    isError: true,
    structuredContent: { stdout: "1 failing: usage section missing example", stderr: "", exit_code: 1 }
  })])
  message(GOOSE_SESSION, "assistant", 9, [
    call("toolu_write", "write", { path: "/work/demo/docs/usage.md", content: "# Usage\n\nRun `npm start`.\n" })
  ], usage(1600, 70, 1500))
  message(GOOSE_SESSION, "user", 10, [result("toolu_write", "Created /work/demo/docs/usage.md (3 lines)")])
  message(GOOSE_SESSION, "assistant", 11, [call("toolu_test2", "shell", { command: "npm test" })], usage(1700, 40, 1600))
  message(GOOSE_SESSION, "user", 12, [result("toolu_test2", "2 passing", { structuredContent: { stdout: "2 passing", stderr: "", exit_code: 0 } })])
  message(GOOSE_SESSION, "assistant", 13, [{ type: "text", text: reply }], usage(1800, 60, 1700))

  // ------------------------------------------------------------------ subagent (summon `delegate`)
  message(GOOSE_SUBAGENT, "user", 20, [{ type: "text", text: `Subagent ID: ${GOOSE_SUBAGENT}\n\nFind all TODO comments in src/.` }])
  message(GOOSE_SUBAGENT, "assistant", 21, [call("toolu_rg", "shell", { command: "rg -n TODO src" })], usage(900, 30, 0))
  message(GOOSE_SUBAGENT, "user", 22, [result("toolu_rg", "\n\nCommand exited with code 1", {
    isError: true,
    structuredContent: { stdout: "", stderr: "", exit_code: 1 }
  })])
  message(GOOSE_SUBAGENT, "assistant", 23, [{ type: "text", text: "There are no TODO comments in src/." }], usage(950, 20, 800))

  // ------------------------------------------------------------------ hidden (session naming)
  message(GOOSE_HIDDEN, "user", 14, [{ type: "text", text: "Name this session." }])
  message(GOOSE_HIDDEN, "assistant", 14, [{ type: "text", text: "Add README usage section" }])

  // ------------------------------------------------------------------ legacy session, imported
  const legacyMessage = (id: string, role: string, created: number, content: ReadonlyArray<object>) => ({ id, role, created, content })
  const imported = [
    legacyMessage("msg_a1", "user", 1747728000, [{ type: "text", text: "Say hello" }]),
    legacyMessage("msg_a2", "assistant", 1747728005, [{ type: "text", text: "Hello!" }])
  ]
  for (const m of imported) {
    insertMessage.run(m.id, GOOSE_IMPORTED, m.role, JSON.stringify(m.content), m.created, "2025-05-20 08:00:00", JSON.stringify(visible))
  }
  db.close()

  // The file Goose imported from stays on disk; Bridge lists the session once, from the database.
  write(
    join(sessionsDir, `${GOOSE_IMPORTED}.jsonl`),
    jsonl([{ working_dir: "/work/old", description: "Say hello", schedule_id: null, message_count: 2 }, ...imported])
  )

  // ------------------------------------------------------------------ legacy session, never imported
  const legacyResult = (id: string, forModel: string, forUser: string) => ({
    type: "toolResponse",
    id,
    toolResult: {
      status: "success",
      value: [
        { type: "text", text: forModel, annotations: { audience: ["assistant"] } },
        { type: "text", text: forUser, annotations: { audience: ["user"], priority: 0 } }
      ]
    }
  })
  const legacyCall = (id: string, name: string, args: object) => ({ type: "toolRequest", id, toolCall: { status: "success", value: { name, arguments: args } } })
  write(
    join(sessionsDir, `${GOOSE_LEGACY}.jsonl`),
    jsonl([
      { working_dir: "/work/legacy", description: "Check the build", schedule_id: null, message_count: 6, total_tokens: 2400, input_tokens: 2000, output_tokens: 400 },
      legacyMessage("msg_l1", "user", 1749632400, [{ type: "text", text: "Run the build and show me the README." }]),
      legacyMessage("msg_l2", "assistant", 1749632402, [
        { type: "text", text: "Let me look at the README." },
        legacyCall("call_view", "developer__text_editor", { command: "view", path: "/work/legacy/README.md" })
      ]),
      legacyMessage("msg_l3", "user", 1749632403, [legacyResult("call_view", "```\n1: # Legacy\n```", "# Legacy")]),
      legacyMessage("msg_l4", "assistant", 1749632404, [legacyCall("call_build", "developer__shell", { command: "npm run build" })]),
      legacyMessage("msg_l5", "user", 1749632410, [legacyResult("call_build", "build ok", "build ok")]),
      legacyMessage("msg_l6", "assistant", 1749632411, [{ type: "text", text: "The build succeeded." }])
    ])
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) generate()
