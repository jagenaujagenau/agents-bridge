/**
 * Writes the sanitized Grok Build fixtures into packages/testing/fixtures/grok (GROK_HOME) for the
 * spec §63 scenario:
 *
 *   user asks to add a Usage section to README.md → agent reads README.md → edits it →
 *   runs `npm test` (fails) → creates docs/usage.md → runs `npm test` (passes) → replies.
 *
 * Plus one malformed line, one unknown update type, one injected `<system-reminder>` notice, a
 * spawned subagent (its own session directory, linked by `summary.json`), a `chat_history.jsonl`
 * that must not be read a second time, and a decoy `auth.json` that must never be read.
 *
 * Layout and shapes follow Grok CLI 1.0.60 (`sessions/<encodeURIComponent(cwd)>/<id>/`,
 * `updates.jsonl` of ACP session updates, `summary.json`). No real history is copied.
 *
 * Run: node packages/adapter-grok/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** UUIDv7 session IDs, as Grok generates them. */
export const GROK_SESSION = "01990a00-0000-7000-8000-00000000a001"
export const GROK_SUBAGENT = "01990a00-0000-7000-8000-00000000a002"

const home = fileURLToPath(new URL("../../testing/fixtures/grok/", import.meta.url))
const cwd = "/work/demo"
const prompt = "Add a Usage section to README.md and make sure the tests pass."
const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
const iso = (s: number) => `2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`
const ms = (s: number) => Date.parse(iso(s))

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const jsonl = (records: ReadonlyArray<unknown>) => records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"

/** One `updates.jsonl` line: an ACP session/update notification with Grok's envelope and `_meta`. */
const updates = (sessionId: string) => {
  let n = 0
  return (s: number, update: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({
    timestamp: ms(s) / 1000,
    method: ["turn_completed", "auto_compact_completed"].includes(String(update["sessionUpdate"])) ? "_x.ai/session/update" : "session/update",
    params: {
      sessionId,
      update,
      _meta: { eventId: `${sessionId.slice(-4)}-e${String(++n).padStart(3, "0")}`, agentTimestampMs: ms(s), ...meta }
    }
  })
}

const canonical = (name: string, label: string, readOnly: boolean) => ({ "x.ai/tool": { name, version: 1, namespace: "grok_build", label, read_only: readOnly } })
const text = (value: string) => ({ type: "content", content: { type: "text", text: value } })

export const generate = () => {
  rmSync(home, { recursive: true, force: true })
  const group = join(home, "sessions", encodeURIComponent(cwd))

  // A decoy: Grok keeps its login here. The adapter only walks sessions/.
  write(join(home, "auth.json"), JSON.stringify({ access_token: "xai-FAKE00000000000000000000000000", refresh_token: "FAKE" }, null, 2))

  // ---- The scenario session ------------------------------------------------
  const main = join(group, GROK_SESSION)
  const u = updates(GROK_SESSION)
  const turn = { promptId: "prompt-a1" }
  const stream = (start: number) => ({ ...turn, streamStartMs: ms(start) })
  write(
    join(main, "summary.json"),
    JSON.stringify({
      info: { id: GROK_SESSION, cwd },
      session_summary: "Added a Usage section to the README and a usage doc; tests pass.",
      generated_title: "Add README usage section",
      title_is_manual: false,
      created_at: iso(1),
      updated_at: iso(14),
      num_messages: 19,
      num_chat_messages: 12,
      current_model_id: "grok-4.6",
      head_branch: "main",
      last_turn_summary: "README usage added"
    }, null, 2)
  )
  write(
    join(main, "updates.jsonl"),
    jsonl([
      u(1, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compress history" }] }),
      u(1, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "<system-reminder>\nThe user's OS is darwin. Working directory: /work/demo\n</system-reminder>" } }, { promptIndex: 0 }),
      u(1, { sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt } }, { promptIndex: 0, modelId: "grok-4.6" }),
      u(2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should read the README first." } }, { ...stream(2), chunkId: 1 }),
      u(2, {
        sessionUpdate: "tool_call",
        toolCallId: "call_read",
        title: "Read README.md",
        kind: "read",
        status: "pending",
        rawInput: { path: "/work/demo/README.md" },
        locations: [{ path: "/work/demo/README.md" }],
        _meta: canonical("read_file", "Read", true)
      }, turn),
      u(4, { sessionUpdate: "tool_call_update", toolCallId: "call_read", status: "completed", content: [text("# Demo\nA demo project.")] }, turn),
      u(5, {
        sessionUpdate: "tool_call",
        toolCallId: "call_edit",
        title: "Edit README.md",
        kind: "edit",
        status: "in_progress",
        rawInput: { file_path: "/work/demo/README.md", old_string: "A demo project.", new_string: "A demo project.\n\n## Usage\n\nRun `npm start`." },
        locations: [{ path: "/work/demo/README.md" }],
        _meta: canonical("search_replace", "Edit", false)
      }, turn),
      u(6, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_edit",
        status: "completed",
        content: [{ type: "diff", path: "/work/demo/README.md", oldText: "# Demo\nA demo project.\n", newText: "# Demo\nA demo project.\n\n## Usage\n\nRun `npm start`.\n" }]
      }, turn),
      "{\"timestamp\":1788256806.5,\"method\":\"session/update\",\"params\":{\"sessionId\":\"broken", // malformed
      u(7, {
        sessionUpdate: "tool_call",
        toolCallId: "call_test1",
        title: "npm test",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm test", description: "Run the test suite" },
        _meta: canonical("run_terminal_command", "Shell", false)
      }, turn),
      u(8, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_test1",
        status: "completed",
        content: [text("1 failing: usage section missing example\nExit code: 1")],
        rawOutput: { output_for_prompt: "1 failing: usage section missing example\nExit code: 1", exit_code: 1, truncated: false, current_dir: cwd }
      }, turn),
      u(8, { sessionUpdate: "future_update_kind", somethingNew: true }, turn), // unknown
      u(9, {
        sessionUpdate: "tool_call",
        toolCallId: "call_write",
        title: "Write docs/usage.md",
        kind: "edit",
        status: "in_progress",
        rawInput: { file_path: "/work/demo/docs/usage.md", content: "# Usage\n\nRun `npm start`.\n" },
        locations: [{ path: "/work/demo/docs/usage.md" }],
        _meta: canonical("write", "Write", false)
      }, turn),
      u(10, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_write",
        status: "completed",
        content: [{ type: "diff", path: "/work/demo/docs/usage.md", oldText: null, newText: "# Usage\n\nRun `npm start`.\n" }]
      }, turn),
      u(11, {
        sessionUpdate: "tool_call",
        toolCallId: "call_test2",
        title: "npm test",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm test" },
        _meta: canonical("run_terminal_command", "Shell", false)
      }, turn),
      u(12, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_test2",
        status: "completed",
        content: [text("2 passing\nExit code: 0")],
        rawOutput: { output_for_prompt: "2 passing\nExit code: 0", exit_code: 0, truncated: false, current_dir: cwd }
      }, turn),
      u(12, {
        sessionUpdate: "tool_call",
        toolCallId: "call_spawn",
        title: "Find TODO comments",
        kind: "other",
        status: "in_progress",
        rawInput: { subagent_type: "explore", description: "Find TODO comments", prompt: "Find all TODO comments in src/." },
        _meta: canonical("spawn_subagent", "Agent", false)
      }, turn),
      u(13, { sessionUpdate: "tool_call_update", toolCallId: "call_spawn", status: "completed", content: [text("There are no TODO comments in src/.")] }, turn),
      u(13, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Added a Usage section to README.md " } }, { ...stream(13), chunkId: 2 }),
      u(13, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "and docs/usage.md. Tests pass." } }, { ...stream(13), chunkId: 3 }),
      u(14, {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-a1",
        stop_reason: "end_turn",
        usage: {
          inputTokens: 4200,
          outputTokens: 310,
          totalTokens: 4510,
          cachedReadTokens: 2800,
          cacheCreationTokens: 0,
          reasoningTokens: 90,
          modelCalls: 6,
          modelUsage: { "grok-4.6": { inputTokens: 4200, outputTokens: 310, modelCalls: 6 } }
        }
      })
    ])
  )
  // The model-facing copy of the same conversation. Reading it as well would double every fact.
  write(
    join(main, "chat_history.jsonl"),
    jsonl([
      { type: "user", id: "c1", timestamp: iso(1), content: "<user_info>\nOS: darwin\n</user_info>" },
      { type: "user", id: "c2", timestamp: iso(1), content: `<user_query>\n${prompt}\n</user_query>` },
      { type: "assistant", id: "c3", timestamp: iso(13), content: reply }
    ])
  )

  // ---- The subagent spawned by call_spawn: its own session, linked by summary.json ----
  const sub = join(group, GROK_SUBAGENT)
  const v = updates(GROK_SUBAGENT)
  const subTurn = { promptId: "prompt-b1" }
  write(
    join(sub, "summary.json"),
    JSON.stringify({
      info: { id: GROK_SUBAGENT, cwd },
      generated_title: "Find TODO comments",
      created_at: iso(20),
      updated_at: iso(23),
      num_messages: 6,
      current_model_id: "grok-4.6",
      parent_session_id: GROK_SESSION,
      session_kind: "subagent",
      subagent_type: "explore"
    }, null, 2)
  )
  write(
    join(sub, "updates.jsonl"),
    jsonl([
      v(20, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Find all TODO comments in src/." } }, { promptIndex: 0, modelId: "grok-4.6" }),
      v(21, {
        sessionUpdate: "tool_call",
        toolCallId: "call_grep",
        title: "grep TODO",
        kind: "search",
        status: "in_progress",
        rawInput: { pattern: "TODO", path: "/work/demo/src" },
        _meta: canonical("grep", "Grep", true)
      }, subTurn),
      v(22, { sessionUpdate: "tool_call_update", toolCallId: "call_grep", status: "completed", content: [text("No matches found")] }, subTurn),
      v(23, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "There are no TODO comments in src/." } }, { ...subTurn, streamStartMs: ms(23), chunkId: 1 }),
      v(23, { sessionUpdate: "turn_completed", prompt_id: "prompt-b1", stop_reason: "end_turn", usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940, modelCalls: 2 } })
    ])
  )
  write(join(home, "sessions", encodeURIComponent(cwd), GROK_SESSION, "subagents", GROK_SUBAGENT, "meta.json"), JSON.stringify({ subagent_type: "explore", session_id: GROK_SUBAGENT }, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate()
  console.log(`generated grok fixtures in ${home}`)
}
