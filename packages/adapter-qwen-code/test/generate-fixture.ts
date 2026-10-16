/**
 * Regenerates the sanitized Qwen Code fixtures (spec §63 scenario) under
 * packages/testing/fixtures/qwen-code, laid out like `QWEN_HOME`:
 *
 *   projects/-work-demo/chats/<main>.jsonl                      the scenario
 *   projects/-work-demo/chats/<main>.ledger.jsonl, .runtime.json sidecars (never sessions)
 *   projects/-work-demo/chats/archive/<branched>.jsonl           an archived session with a /rewind branch
 *   projects/-work-demo/subagents/<main>/agent-<id>.jsonl         a subagent transcript (+ .meta.json)
 *   oauth_creds.json                                              decoy credential, never read
 *
 * Record shapes follow `ChatRecordingService` and `attachJsonlTranscriptWriter`
 * in @qwen-code/qwen-code-core 0.25.2. Nothing is copied from real history.
 * Run: node packages/adapter-qwen-code/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const QWEN_MAIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
export const QWEN_BRANCHED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
export const QWEN_AGENT = "agent-explore-7f3c"

const home = fileURLToPath(new URL("../../testing/fixtures/qwen-code/", import.meta.url))
const cwd = "/work/demo"
const project = join(home, "projects", "-work-demo")
const prompt = "Add a Usage section to README.md and make sure the tests pass."
const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
const t = (s: number) => `2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`
const model = "qwen3-coder-plus"

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const jsonl = (records: ReadonlyArray<unknown>) =>
  records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"

/** A linear chain of records for one session file. */
const chain = (sessionId: string, prefix: string, extra: object = {}) => {
  let n = 0
  let parent: string | null = null
  const uuid = () => `${prefix}${String(++n).padStart(7, "0")}-0000-4000-8000-000000000000`
  const record = (s: number, type: string, body: object, options: { parent?: string | null; tail?: boolean } = {}) => {
    const id = uuid()
    const r = {
      uuid: id,
      parentUuid: options.parent !== undefined ? options.parent : parent,
      sessionId,
      timestamp: t(s),
      type,
      cwd,
      version: "0.25.2",
      gitBranch: "main",
      ...extra,
      ...body
    }
    if (options.tail !== false) parent = id
    return r
  }
  return { record, last: () => parent }
}

const usage = (prompt: number, cached: number, completion: number, reasoning: number) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: completion,
  totalTokenCount: prompt + completion,
  cachedContentTokenCount: cached,
  thoughtsTokenCount: reasoning
})

const shellText = (command: string, output: string, code: number) =>
  [`Command: ${command}`, "Directory: (root)", `Output: ${output}`, "Error: (none)", `Exit Code: ${code}`, "Signal: (none)", "Process Group PGID: 4242"].join("\n")

const shellDisplay = (output: string, code: number) => ({
  type: "shell_result",
  version: 1,
  text: output,
  output,
  directory: cwd,
  exitCode: code,
  signal: null,
  pid: 4242,
  error: null,
  outcome: code === 0 ? "completed" : "failed",
  notices: [],
  truncated: false,
  outputFiles: []
})

const call = (id: string, name: string, args: object) => ({ functionCall: { id, name, args } })
const response = (id: string, name: string, body: object) => ({ role: "user", parts: [{ functionResponse: { id, name, response: body } }] })

const scenario = () => {
  const { record } = chain(QWEN_MAIN, "a")
  const executionContext = { modelId: model, authType: "openai", approvalMode: "default" }
  const hook = "Project uses vitest."
  return [
    record(0, "system", { subtype: "session_model", systemPayload: { modelId: model, authType: "openai" } }),
    record(1, "user", {
      executionContext,
      promptId: "prompt-1",
      message: {
        role: "user",
        parts: [{ text: prompt }, { text: `<qwen:user-prompt-submit-context>\n${hook}\n</qwen:user-prompt-submit-context>` }]
      },
      systemPayload: { displayText: prompt, hookContext: hook }
    }),
    record(3, "assistant", {
      model,
      contextWindowSize: 1000000,
      message: { role: "model", parts: [{ text: "I should read the README first.", thought: true }, call("call_read", "read_file", { file_path: "/work/demo/README.md" })] },
      usageMetadata: usage(120, 100, 13, 5)
    }),
    record(4, "tool_result", {
      message: response("call_read", "read_file", { output: "# Demo\nA demo project.\n" }),
      toolCallResult: { callId: "call_read", status: "success", resultDisplay: "", executionStatus: "completed" }
    }),
    record(4, "system", { subtype: "ui_telemetry", systemPayload: { uiEvent: { "event.name": "qwen-code.tool_call", function_name: "read_file" } } }),
    record(5, "assistant", {
      model,
      message: {
        role: "model",
        parts: [call("call_edit", "edit", { file_path: "/work/demo/README.md", old_string: "A demo project.", new_string: "A demo project.\n\n## Usage" })]
      },
      usageMetadata: usage(140, 120, 20, 0)
    }),
    record(6, "tool_result", {
      message: response("call_edit", "edit", { output: "The file: /work/demo/README.md has been updated." }),
      toolCallResult: {
        callId: "call_edit",
        status: "success",
        resultDisplay: {
          fileDiff: "Index: README.md\n===================================================================\n--- README.md\tCurrent\n+++ README.md\tProposed\n@@ -1,2 +1,4 @@\n # Demo\n A demo project.\n+\n+## Usage\n",
          fileName: "README.md",
          filePath: "/work/demo/README.md",
          originalContent: "# Demo\nA demo project.\n",
          newContent: "# Demo\nA demo project.\n\n## Usage\n"
        }
      }
    }),
    "{\"uuid\":\"broken\",\"type\":\"assistant\",", // malformed
    record(7, "assistant", {
      model,
      message: { role: "model", parts: [call("call_test1", "run_shell_command", { command: "npm test", is_background: false, description: "Run tests" })] },
      usageMetadata: usage(160, 140, 18, 0)
    }),
    record(8, "tool_result", {
      message: response("call_test1", "run_shell_command", { error: shellText("npm test", "1 failing: usage section missing example", 1) }),
      toolCallResult: {
        callId: "call_test1",
        status: "error",
        resultDisplay: shellDisplay("1 failing: usage section missing example", 1),
        error: {},
        errorType: "shell_execute_error"
      }
    }),
    { uuid: "future-0001", parentUuid: null, sessionId: QWEN_MAIN, timestamp: t(8), type: "future_record_type", something: true },
    record(9, "assistant", {
      model,
      message: { role: "model", parts: [call("call_write", "write_file", { file_path: "/work/demo/docs/usage.md", content: "# Usage\n" })] },
      usageMetadata: usage(180, 160, 16, 0)
    }),
    record(10, "tool_result", {
      message: response("call_write", "write_file", { output: "Successfully created and wrote to new file: /work/demo/docs/usage.md." }),
      toolCallResult: {
        callId: "call_write",
        status: "success",
        resultDisplay: {
          fileDiff: "Index: usage.md\n===================================================================\n--- usage.md\tOriginal\n+++ usage.md\tWritten\n@@ -0,0 +1 @@\n+# Usage\n",
          fileName: "usage.md",
          filePath: "/work/demo/docs/usage.md",
          originalContent: "",
          newContent: "# Usage\n"
        }
      }
    }),
    record(11, "assistant", {
      model,
      message: { role: "model", parts: [call("call_test2", "run_shell_command", { command: "npm test", is_background: false, description: "Run tests again" })] },
      usageMetadata: usage(200, 180, 18, 0)
    }),
    record(12, "tool_result", {
      message: response("call_test2", "run_shell_command", { output: shellText("npm test", "2 passing", 0) }),
      toolCallResult: { callId: "call_test2", status: "success", resultDisplay: shellDisplay("2 passing", 0) }
    }),
    record(13, "assistant", { model, message: { role: "model", parts: [{ text: reply }] }, usageMetadata: usage(220, 200, 17, 0) }),
    record(14, "system", { subtype: "custom_title", systemPayload: { customTitle: "Add README usage section", titleSource: "auto" } }, { tail: false })
  ]
}

const subagent = () => {
  const { record } = chain(QWEN_MAIN, "b", { agentId: "explore-7f3c", agentName: "Explore", isSidechain: true })
  return [
    record(20, "user", { message: { role: "user", parts: [{ text: "Find all TODO comments in src/." }] } }),
    record(21, "assistant", {
      message: { role: "model", parts: [{ text: "Search src/ for TODO.", thought: true }] },
      usageMetadata: usage(50, 0, 9, 4),
      agentRunId: "run-1",
      agentRound: 1
    }),
    record(21, "assistant", { message: { role: "model", parts: [call("call_grep", "grep_search", { pattern: "TODO", path: "src" })] } }),
    record(22, "tool_result", {
      message: response("call_grep", "grep_search", { output: "No matches found for pattern \"TODO\" in path \"src\"." }),
      toolCallResult: { callId: "call_grep", durationMs: 12 }
    }),
    record(23, "assistant", {
      message: { role: "model", parts: [{ text: "There are no TODO comments in src/." }] },
      usageMetadata: usage(70, 50, 10, 0),
      agentRunId: "run-1",
      agentRound: 2
    })
  ]
}

/** An archived session whose second turn was rewound and asked again. */
const branched = () => {
  const { record } = chain(QWEN_BRANCHED, "c")
  const u1 = record(30, "user", { message: { role: "user", parts: [{ text: "kept prompt" }] } })
  const a1 = record(31, "assistant", { model, message: { role: "model", parts: [{ text: "kept answer" }] } })
  const u2 = record(32, "user", { message: { role: "user", parts: [{ text: "abandoned follow-up" }] } })
  const a2 = record(33, "assistant", { model, message: { role: "model", parts: [{ text: "abandoned answer" }] } })
  const title = record(33, "system", { subtype: "custom_title", systemPayload: { customTitle: "Branch demo" } }, { tail: false })
  const rewind = record(34, "system", { subtype: "rewind", systemPayload: { truncatedCount: 2 } }, { parent: a1.uuid })
  const u3 = record(35, "user", { message: { role: "user", parts: [{ text: "kept follow-up" }] } })
  const a3 = record(36, "assistant", { model, message: { role: "model", parts: [{ text: "kept second answer" }] } })
  return [u1, a1, u2, a2, title, rewind, u3, a3]
}

export const generate = () => {
  rmSync(home, { recursive: true, force: true })
  const chats = join(project, "chats")
  write(join(chats, `${QWEN_MAIN}.jsonl`), jsonl(scenario()))
  write(join(chats, `${QWEN_MAIN}.ledger.jsonl`), jsonl([{ promptId: "prompt-1", state: "completed" }]))
  write(join(chats, `${QWEN_MAIN}.runtime.json`), JSON.stringify({ sessionId: QWEN_MAIN, workDir: cwd, pid: 4242 }, null, 2))
  write(join(chats, "archive", `${QWEN_BRANCHED}.jsonl`), jsonl(branched()))
  const agents = join(project, "subagents", QWEN_MAIN)
  write(join(agents, `${QWEN_AGENT}.jsonl`), jsonl(subagent()))
  write(join(agents, `${QWEN_AGENT}.meta.json`), JSON.stringify({
    agentId: "explore-7f3c",
    agentType: "Explore",
    description: "Find TODO comments",
    parentSessionId: QWEN_MAIN,
    toolUseId: "call_agent",
    parentAgentId: null,
    createdAt: t(20),
    status: "completed"
  }, null, 2))
  // Qwen OAuth credentials live beside the history; the adapter only walks projects/.
  write(join(home, "oauth_creds.json"), JSON.stringify({ access_token: "FAKE-qwen-oauth-token-never-read", refresh_token: "FAKE" }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate()
  console.log(`generated qwen-code fixtures in ${home}`)
}
