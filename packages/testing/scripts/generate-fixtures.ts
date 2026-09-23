/**
 * Regenerates the sanitized native fixtures for harnesses added after the first
 * slice. Every fixture records the same spec §63 scenario:
 *
 *   user asks to add a Usage section to README.md → agent reads README.md →
 *   edits it → runs `npm test` (fails) → creates docs/usage.md →
 *   runs `npm test` (passes) → replies.
 *
 * Plus one malformed record, one unknown record type and one injected notice,
 * where the format allows it. Run: node packages/testing/scripts/generate-fixtures.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../fixtures/", import.meta.url))
const cwd = "/work/demo"
const prompt = "Add a Usage section to README.md and make sure the tests pass."
const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
const t = (s: number) => `2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`
const ms = (s: number) => Date.parse(t(s))

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const jsonl = (records: ReadonlyArray<unknown>) =>
  records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"

export const generators: Record<string, () => void> = {}

// ---------------------------------------------------------------------------- pi
generators["pi"] = () => {
  const dir = join(root, "pi", "sessions", "--work-demo--")
  rmSync(join(root, "pi"), { recursive: true, force: true })
  const id = "55555555-5555-4555-8555-555555555555"
  const stamp = "2026-09-01T10-00-00-000Z"
  let n = 0
  let parent: string | null = null
  const entry = (s: number, body: object) => {
    const eid = `e${String(++n).padStart(7, "0")}`
    const record = { id: eid, parentId: parent, timestamp: t(s), ...body }
    parent = eid
    return record
  }
  const assistant = (s: number, content: ReadonlyArray<object>, stopReason = "toolUse") =>
    entry(s, {
      type: "message",
      message: { role: "assistant", content, model: "gpt-5.5", provider: "openai", stopReason, usage: { input: 12, output: 4, cacheRead: 30, cacheWrite: 0, totalTokens: 46 }, timestamp: ms(s) }
    })
  const result = (s: number, toolCallId: string, toolName: string, text: string, isError = false, details?: object) =>
    entry(s, {
      type: "message",
      message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, details, timestamp: ms(s) }
    })
  write(
    join(dir, `${stamp}_${id}.jsonl`),
    jsonl([
      { type: "session", version: 3, id, timestamp: t(0), cwd },
      entry(0, { type: "model_change", provider: "openai", modelId: "gpt-5.5" }),
      entry(0, { type: "thinking_level_change", thinkingLevel: "medium" }),
      entry(1, { type: "message", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: ms(1) } }),
      assistant(2, [
        { type: "thinking", thinking: "I should read the README first.", thinkingSignature: "sig" },
        { type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } }
      ]),
      result(4, "call_read", "read", "# Demo\nA demo project."),
      assistant(5, [{
        type: "toolCall",
        id: "call_edit",
        name: "edit",
        arguments: { path: "README.md", edits: [{ oldText: "A demo project.", newText: "A demo project.\n\n## Usage\n\nRun `npm start`." }] }
      }]),
      result(6, "call_edit", "edit", "Successfully replaced 1 block(s) in README.md.", false, {
        diff: "  1 # Demo\n  2 A demo project.\n+ 3 \n+ 4 ## Usage\n+ 5 \n+ 6 Run `npm start`.",
        firstChangedLine: 3
      }),
      "{\"type\":\"message\",\"id\":\"broken", // malformed
      assistant(7, [{ type: "toolCall", id: "call_test1", name: "bash", arguments: { command: "npm test" } }]),
      result(8, "call_test1", "bash", "1 failing: usage section missing example\n\nCommand exited with code 1", true),
      entry(8, { type: "future_entry_type", something: true }),
      entry(8, { type: "custom", customType: "extension-state", data: {} }),
      assistant(9, [{ type: "toolCall", id: "call_write", name: "write", arguments: { path: "docs/usage.md", content: "# Usage\n\nRun `npm start`.\n" } }]),
      result(10, "call_write", "write", "Successfully wrote 27 bytes to docs/usage.md"),
      assistant(11, [{ type: "toolCall", id: "call_test2", name: "bash", arguments: { command: "npm test" } }]),
      result(12, "call_test2", "bash", "2 passing"),
      assistant(13, [{ type: "text", text: reply }], "stop"),
      entry(14, { type: "session_info", name: "Add README usage section" })
    ])
  )
  // A session navigated with /tree: the first answer was abandoned and the conversation continued from the prompt.
  const branchedId = "67676767-6767-4767-8767-676767676767"
  write(
    join(dir, `2026-09-01T11-00-00-000Z_${branchedId}.jsonl`),
    jsonl([
      { type: "session", version: 3, id: branchedId, timestamp: t(30), cwd },
      { type: "message", id: "b1", parentId: null, timestamp: t(31), message: { role: "user", content: [{ type: "text", text: "kept prompt" }] } },
      { type: "message", id: "b2", parentId: "b1", timestamp: t(32), message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }], stopReason: "stop" } },
      { type: "thinking_level_change", id: "b3", parentId: "b1", timestamp: t(33), thinkingLevel: "high" },
      { type: "message", id: "b4", parentId: "b3", timestamp: t(34), message: { role: "user", content: [{ type: "text", text: "kept follow-up" }] } },
      { type: "message", id: "b5", parentId: "b4", timestamp: t(35), message: { role: "assistant", content: [{ type: "text", text: "kept answer" }], stopReason: "stop" } }
    ])
  )
  const childId = "66666666-6666-4666-8666-666666666666"
  n = 0
  parent = null
  write(
    join(dir, `${stamp}_${id}`, "explorer", "run-0", "session.jsonl"),
    jsonl([
      { type: "session", version: 3, id: childId, timestamp: t(20), cwd },
      entry(20, { type: "message", message: { role: "user", content: [{ type: "text", text: "Find all TODO comments in src/." }], timestamp: ms(20) } }),
      assistant(21, [{ type: "toolCall", id: "call_grep", name: "grep", arguments: { pattern: "TODO", path: "src" } }]),
      result(22, "call_grep", "grep", "No matches found"),
      assistant(23, [{ type: "text", text: "There are no TODO comments in src/." }], "stop")
    ])
  )
}

// ---------------------------------------------------------------------------- opencode
generators["opencode"] = () => {
  const dir = join(root, "opencode")
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, "opencode.db"))
  db.exec(`
    create table session (id text primary key, project_id text not null, parent_id text, slug text not null,
      directory text not null, title text not null, version text not null, agent text, model text,
      time_created integer not null, time_updated integer not null);
    create table message (id text primary key, session_id text not null, time_created integer not null,
      time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, time_updated integer not null, data text not null);
    create table account (id text primary key, email text not null, access_token text not null);
    insert into account values ('acc_1', 'someone@example.invalid', 'sk-ant-FAKE0000000000000000000000000000');
  `)
  const parentId = "ses_77777777parent"
  const childId = "ses_88888888child"
  const insertSession = db.prepare("insert into session values (?, 'prj_1', ?, ?, ?, ?, '1.18.23', ?, 'gpt-5.5', ?, ?)")
  insertSession.run(parentId, null, "demo", cwd, "Add README usage section", "build", ms(0), ms(14))
  insertSession.run(childId, parentId, "todo", cwd, "Find TODO comments (@explore subagent)", "explore", ms(20), ms(23))

  const insertMessage = db.prepare("insert into message values (?, ?, ?, ?, ?)")
  const insertPart = db.prepare("insert into part values (?, ?, ?, ?, ?, ?)")
  let m = 0
  let p = 0
  const message = (session: string, s: number, data: object, parts: ReadonlyArray<object | string>) => {
    const id = `msg_${String(++m).padStart(4, "0")}`
    insertMessage.run(id, session, ms(s), ms(s), JSON.stringify(data))
    for (const part of parts) {
      insertPart.run(`prt_${String(++p).padStart(4, "0")}`, id, session, ms(s), ms(s), typeof part === "string" ? part : JSON.stringify(part))
    }
  }
  const user = (session: string, s: number, parts: ReadonlyArray<object>) =>
    message(session, s, { role: "user", time: { created: ms(s) }, agent: "build", model: { providerID: "openai", modelID: "gpt-5.5" } }, parts)
  const assistant = (session: string, s: number, parts: ReadonlyArray<object | string>) =>
    message(session, s, { role: "assistant", time: { created: ms(s), completed: ms(s) }, modelID: "gpt-5.5", providerID: "openai", path: { cwd, root: cwd }, finish: "tool-calls" }, [
      { type: "step-start" },
      ...parts,
      { type: "step-finish", reason: "tool-calls", cost: 0, tokens: { input: 1, output: 1 } }
    ])
  const tool = (s: number, callID: string, name: string, input: object, output: string, metadata: object, status = "completed") => ({
    type: "tool", callID, tool: name,
    state: { status, input, output, title: name, metadata, time: { start: ms(s), end: ms(s) + 120 } }
  })

  user(parentId, 1, [
    { type: "text", text: prompt },
    { type: "text", text: "<system-reminder>Plan mode is off.</system-reminder>", synthetic: true }
  ])
  assistant(parentId, 2, [
    { type: "reasoning", text: "I should read the README first.", time: { start: ms(2), end: ms(2) } },
    tool(3, "call_read", "read", { filePath: "/work/demo/README.md" }, "<file>\n1 # Demo\n2 A demo project.\n</file>", { preview: "# Demo" })
  ])
  assistant(parentId, 5, [
    tool(5, "call_edit", "edit", { filePath: "/work/demo/README.md", oldString: "A demo project.", newString: "A demo project.\n\n## Usage" }, "Edit applied successfully.", {
      diff: "Index: /work/demo/README.md\n@@ -1,2 +1,5 @@\n # Demo\n A demo project.\n+\n+## Usage\n",
      filediff: {}
    })
  ])
  assistant(parentId, 7, [
    tool(7, "call_test1", "bash", { command: "npm test", description: "Run tests" }, "1 failing: usage section missing example", { output: "1 failing: usage section missing example", exit: 1, description: "Run tests" }),
    "{\"type\":\"text\",\"text\":", // malformed part
    { type: "future-part", something: true }
  ])
  assistant(parentId, 9, [
    tool(9, "call_write", "write", { filePath: "/work/demo/docs/usage.md", content: "# Usage\n" }, "Wrote file successfully.", { filepath: "/work/demo/docs/usage.md", exists: false })
  ])
  assistant(parentId, 11, [
    tool(11, "call_test2", "bash", { command: "npm test", description: "Run tests again" }, "2 passing", { output: "2 passing", exit: 0, description: "Run tests again" })
  ])
  assistant(parentId, 13, [{ type: "text", text: reply, time: { start: ms(13), end: ms(13) } }])

  user(childId, 20, [{ type: "text", text: "Find all TODO comments in src/." }])
  assistant(childId, 21, [tool(21, "call_grep", "grep", { pattern: "TODO", path: "src" }, "No files found", { matches: 0 })])
  assistant(childId, 23, [{ type: "text", text: "There are no TODO comments in src/." }])
  db.close()
}

// ---------------------------------------------------------------------------- gemini-cli
generators["gemini-cli"] = () => {
  const home = join(root, "gemini-cli")
  rmSync(home, { recursive: true, force: true })
  const gemini = join(home, ".gemini")
  write(join(gemini, "trustedFolders.json"), JSON.stringify({ [cwd]: "TRUST_FOLDER" }, null, 2))
  const projectDir = join(gemini, "tmp", createHash("sha256").update(cwd).digest("hex"))
  const shell = (command: string, code: number, output: string) =>
    `Command: ${command}\nDirectory: (root)\nOutput: ${output}\nError: (none)\nExit Code: ${code}\nSignal: (none)\nBackground PIDs: (none)\nProcess Group PGID: 4242`
  const call = (s: number, id: string, name: string, args: object, output: string, extra: object = {}) => ({
    id, name, args, status: "success", timestamp: t(s), displayName: name, description: "",
    result: [{ functionResponse: { id, name, response: { output } } }],
    ...extra
  })
  const conversation = {
    sessionId: "99999999-aaaa-4aaa-8aaa-999999999999",
    projectHash: createHash("sha256").update(cwd).digest("hex"),
    startTime: t(0),
    lastUpdated: t(14),
    summary: "Add README usage section",
    messages: [
      { id: "m0", timestamp: t(0), type: "info", content: "Authenticated with Gemini API key." },
      { id: "m1", timestamp: t(1), type: "user", content: `${prompt}\n--- Content from referenced files ---\nREADME.md: # Demo\n--- End of content ---` },
      {
        id: "m2", timestamp: t(3), type: "gemini", model: "gemini-3-pro", content: "",
        tokens: { input: 120, output: 8, cached: 100, thoughts: 5, tool: 0, total: 133 },
        thoughts: [{ subject: "Planning", description: "I should read the README first.", timestamp: t(2) }],
        toolCalls: [call(3, "call_read", "read_file", { absolute_path: "/work/demo/README.md" }, "# Demo\nA demo project.")]
      },
      { id: "m3", timestamp: t(4), type: "user", content: [{ functionResponse: { id: "call_read", name: "read_file", response: { output: "# Demo" } } }] },
      {
        id: "m4", timestamp: t(5), type: "gemini", content: "",
        toolCalls: [call(5, "call_edit", "replace", { file_path: "/work/demo/README.md", old_string: "A demo project.", new_string: "A demo project.\n\n## Usage" },
          "Successfully modified file: /work/demo/README.md (1 replacements).",
          { resultDisplay: { fileDiff: "@@ -1,2 +1,4 @@\n # Demo\n A demo project.\n+\n+## Usage\n", fileName: "README.md", originalContent: "# Demo\nA demo project.\n", newContent: "…" } })]
      },
      { id: "m5", timestamp: t(6), type: "gemini", toolCalls: "not-an-array" },
      {
        id: "m6", timestamp: t(7), type: "gemini", content: "",
        toolCalls: [call(7, "call_test1", "run_shell_command", { command: "npm test", description: "Run tests" }, shell("npm test", 1, "1 failing: usage section missing example"))]
      },
      { id: "m7", timestamp: t(8), type: "future_message_type", content: "?" },
      {
        id: "m8", timestamp: t(9), type: "gemini", content: "",
        toolCalls: [call(9, "call_write", "write_file", { file_path: "/work/demo/docs/usage.md", content: "# Usage\n" },
          "Successfully created and wrote to new file: /work/demo/docs/usage.md.",
          { resultDisplay: { fileDiff: "@@ -0,0 +1 @@\n+# Usage\n", fileName: "usage.md", originalContent: null, newContent: "# Usage\n" } })]
      },
      {
        id: "m9", timestamp: t(11), type: "gemini", content: "",
        toolCalls: [call(11, "call_test2", "run_shell_command", { command: "npm test", description: "Run tests again" }, shell("npm test", 0, "2 passing"))]
      },
      { id: "m10", timestamp: t(13), type: "gemini", content: [{ text: reply }] }
    ]
  }
  write(join(projectDir, "chats", "session-2026-09-01T10-00-99999999.json"), JSON.stringify(conversation, null, 2))
}

// ---------------------------------------------------------------------------- cursor
generators["cursor"] = () => {
  const home = join(root, "cursor")
  rmSync(home, { recursive: true, force: true })
  const transcripts = join(home, "projects", "work-demo", "agent-transcripts")
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const assistant = (...content: ReadonlyArray<object>) => ({ role: "assistant", message: { content } })
  const tool = (name: string, input: unknown) => ({ type: "tool_use", name, input })
  write(
    join(transcripts, id, `${id}.jsonl`),
    jsonl([
      {
        role: "user",
        message: {
          content: [{
            type: "text",
            text: `<manually_attached_skills>\nUse the testing skill.\n</manually_attached_skills>\n<timestamp>Tuesday, September 1, 2026, 12:00 PM (UTC+2)</timestamp>\n<user_query>\n${prompt}\n</user_query>`
          }]
        }
      },
      assistant(tool("ReadFile", { path: "/work/demo/README.md" })),
      assistant(tool("StrReplace", { path: "/work/demo/README.md", old_string: "A demo project.", new_string: "A demo project.\n\n## Usage" })),
      "{\"role\":\"assistant\",\"message\":", // malformed
      assistant(tool("Shell", { command: "npm test", working_directory: cwd, description: "Run tests" })),
      { type: "future_record", something: true },
      assistant(tool("ApplyPatch", "*** Begin Patch\n*** Add File: /work/demo/docs/usage.md\n+# Usage\n*** End Patch")),
      assistant(tool("Shell", { command: "npm test", working_directory: cwd, description: "Run tests again" })),
      assistant({ type: "text", text: reply }),
      { type: "turn_ended", status: "success" }
    ])
  )
  write(
    join(transcripts, id, "subagents", `${child}.jsonl`),
    jsonl([
      { role: "user", message: { content: [{ type: "text", text: "<user_query>\nFind all TODO comments in src/.\n</user_query>" }] } },
      assistant(tool("rg", { pattern: "TODO", path: "src" })),
      assistant({ type: "text", text: "There are no TODO comments in src/." }),
      { type: "turn_ended", status: "error", error: "Connection lost" }
    ])
  )
}

// ---------------------------------------------------------------------------- antigravity
generators["antigravity"] = () => {
  const home = join(root, "antigravity")
  rmSync(home, { recursive: true, force: true })
  const conversation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  const logs = join(home, "antigravity-cli", "brain", conversation, ".system_generated", "logs")
  let index = 0
  const step = (s: number, type: string, source: string, content: string, extra: object = {}) =>
    ({ step_index: index++, source, type, status: "DONE", created_at: t(s).replace(".000", ""), content, ...extra })
  const call = (name: string, args: object) => ({ name, args })
  write(
    join(logs, "transcript_full.jsonl"),
    jsonl([
      step(0, "CONVERSATION_HISTORY", "MODEL", "earlier replayed turn"),
      step(1, "USER_INPUT", "USER_EXPLICIT", `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe user's OS is mac.\n</ADDITIONAL_METADATA>`),
      step(3, "PLANNER_RESPONSE", "MODEL", "", { tool_calls: [call("view_file", { AbsolutePath: "/work/demo/README.md", toolSummary: "View README" })] }),
      step(4, "VIEW_FILE", "MODEL", "File Path: `file:///work/demo/README.md`\nTotal Lines: 2\n# Demo"),
      step(5, "PLANNER_RESPONSE", "MODEL", "", { tool_calls: [call("replace_file_content", { TargetFile: "/work/demo/README.md", toolSummary: "Add usage" })] }),
      step(6, "CODE_ACTION", "MODEL", "Edited /work/demo/README.md"),
      "{\"step_index\":99,\"type\":", // malformed
      step(7, "PLANNER_RESPONSE", "MODEL", "", { tool_calls: [call("run_command", { CommandLine: "npm test", Cwd: cwd })] }),
      step(8, "RUN_COMMAND", "MODEL", "1 failing: usage section missing example\nExit code: 1"),
      { step_index: index++, source: "SYSTEM", status: "DONE", created_at: t(8).replace(".000", ""), content: "?" },
      step(9, "PLANNER_RESPONSE", "MODEL", "", { tool_calls: [call("write_to_file", { TargetFile: "/work/demo/docs/usage.md", toolSummary: "Create usage doc" })] }),
      step(10, "CODE_ACTION", "MODEL", "Created /work/demo/docs/usage.md"),
      step(11, "PLANNER_RESPONSE", "MODEL", "", { tool_calls: [call("run_command", { CommandLine: "npm test", Cwd: cwd })] }),
      step(12, "RUN_COMMAND", "MODEL", "2 passing\nExit code: 0"),
      step(13, "PLANNER_RESPONSE", "MODEL", reply)
    ])
  )
  write(join(logs, "transcript.jsonl"), jsonl([step(1, "USER_INPUT", "USER_EXPLICIT", "<USER_REQUEST>\npartial\n</USER_REQUEST>")]))
}

// ---------------------------------------------------------------------------- acp
generators["acp"] = () => {
  const dir = join(root, "acp")
  rmSync(dir, { recursive: true, force: true })
  const sessionId = "sess_acp_1"
  const rpc = (s: number, message: object) => ({ receivedAt: t(s), message: { jsonrpc: "2.0", ...message } })
  const update = (s: number, value: object) => rpc(s, { method: "session/update", params: { sessionId, update: value } })
  write(
    join(dir, "claude-code-acp", `${sessionId}.jsonl`),
    jsonl([
      rpc(0, { id: 0, method: "session/new", params: { cwd, mcpServers: [] } }),
      rpc(0, { id: 0, result: { sessionId } }),
      update(0, { sessionUpdate: "available_commands_update", availableCommands: [] }),
      rpc(1, { id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } }),
      update(2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should read " } }),
      update(2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the README first." } }),
      update(2, { sessionUpdate: "plan", entries: [
        { content: "Read README.md", status: "in_progress", priority: "high" },
        { content: "Add a Usage section", status: "pending", priority: "high" },
        { content: "Run the tests", status: "pending", priority: "medium" }
      ] }),
      update(3, { sessionUpdate: "tool_call", toolCallId: "toolu_read", title: "Read README.md", kind: "read", status: "pending", locations: [{ path: "/work/demo/README.md" }], rawInput: { file_path: "/work/demo/README.md" } }),
      update(4, { sessionUpdate: "tool_call_update", toolCallId: "toolu_read", status: "completed", content: [{ type: "content", content: { type: "text", text: "# Demo\nA demo project." } }] }),
      update(5, { sessionUpdate: "tool_call", toolCallId: "toolu_edit", title: "Edit README.md", kind: "edit", status: "in_progress", locations: [{ path: "/work/demo/README.md" }] }),
      update(6, { sessionUpdate: "tool_call_update", toolCallId: "toolu_edit", status: "completed", content: [{ type: "diff", path: "/work/demo/README.md", oldText: "A demo project.", newText: "A demo project.\n\n## Usage" }] }),
      "{\"receivedAt\":\"2026-09-01T10:00:06.500Z\",\"message\":", // malformed
      update(7, { sessionUpdate: "tool_call", toolCallId: "toolu_test1", title: "npm test", kind: "execute", status: "in_progress", rawInput: { command: "npm test", description: "Run tests" } }),
      update(8, { sessionUpdate: "tool_call_update", toolCallId: "toolu_test1", status: "failed", rawOutput: { exitCode: 1, stdout: "1 failing: usage section missing example" }, content: [{ type: "content", content: { type: "text", text: "1 failing: usage section missing example" } }] }),
      update(8, { sessionUpdate: "future_update", something: true }),
      update(9, { sessionUpdate: "tool_call", toolCallId: "toolu_write", title: "Write docs/usage.md", kind: "edit", status: "pending" }),
      update(10, { sessionUpdate: "tool_call_update", toolCallId: "toolu_write", status: "completed", content: [{ type: "diff", path: "/work/demo/docs/usage.md", oldText: null, newText: "# Usage\n" }] }),
      update(11, { sessionUpdate: "tool_call", toolCallId: "toolu_test2", title: "npm test", kind: "execute", status: "in_progress", rawInput: { command: "npm test" } }),
      update(12, { sessionUpdate: "tool_call_update", toolCallId: "toolu_test2", status: "completed", rawOutput: { exitCode: 0, stdout: "2 passing" } }),
      update(13, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Added a Usage section to README.md " } }),
      update(13, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "and docs/usage.md. Tests pass." } }),
      rpc(13, { id: 1, result: { stopReason: "end_turn" } }),
      update(14, { sessionUpdate: "session_info_update", title: "Add README usage section" }),
      update(14, { sessionUpdate: "usage_update", used: 1000, size: 200000 })
    ])
  )
}

const selected = process.argv.slice(2)
for (const [name, generate] of Object.entries(generators)) {
  if (selected.length === 0 || selected.includes(name)) {
    generate()
    console.log(`generated ${name}`)
  }
}
