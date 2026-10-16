/**
 * Writes the sanitized Kimi Code fixture for the spec §63 scenario, laid out like
 * `KIMI_CODE_HOME` (`~/.kimi-code`):
 *
 *   sessions/wd_demo_<sha256(cwd)[:12]>/<session>/state.json          session metadata
 *   sessions/wd_demo_<…>/<session>/agents/main/wire.jsonl             the scenario
 *   sessions/wd_demo_<…>/<session>/agents/agent-1/wire.jsonl          the Agent-tool subagent
 *   sessions/wd_demo_<…>/<session>/agents/main/{blobs,tasks}/…        sidecars (never sessions)
 *   session_index.jsonl                                               session → workDir
 *   config.toml, credentials/kimi-code.json                           decoys (FAKE tokens), never read
 *
 *   user asks to add a Usage section to README.md → agent reads README.md →
 *   edits it → runs `npm test` (fails) → delegates a TODO search to a subagent →
 *   creates docs/usage.md → runs `npm test` (passes) → replies.
 *
 * Plus one malformed line, one unknown record type and one injected `<system-reminder>`.
 * Record shapes follow `@moonshot-ai/kimi-code` 2.2.0 (agent-core-v2, wire protocol 1.5).
 * Nothing is copied from real history.
 *
 * Run: node packages/adapter-kimi/test/generate-fixture.ts
 */
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const KIMI_SESSION = "session_c0dec0de-c0de-4c0d-8c0d-c0dec0dec0de"
export const KIMI_SUBAGENT_AGENT = "agent-1"
/** The subagent's native ID: `<session>/<agentId>`. */
export const KIMI_SUBAGENT = `${KIMI_SESSION}/${KIMI_SUBAGENT_AGENT}`
/** Decoy secrets: the adapter never opens `config.toml` or `credentials/`. */
export const KIMI_DECOY_TOKEN = "FAKE-kimi-access-token-0000000000000000"

const home = fileURLToPath(new URL("../../testing/fixtures/kimi/", import.meta.url))
const cwd = "/work/demo"
const prompt = "Add a Usage section to README.md and make sure the tests pass."
const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
const model = "kimi-k2.6"
const t0 = Date.parse("2026-09-01T10:00:00.000Z")
const t = (s: number) => t0 + s * 1000

/** agent-core-v2 `encodeWorkDirKey`: `wd_<slug of basename>_<sha256(path)[:12]>`. */
export const workDirKey = (workDir: string) =>
  `wd_${workDir.split("/").pop()!.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-")}_${createHash("sha256").update(workDir).digest("hex").slice(0, 12)}`

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
const jsonl = (records: ReadonlyArray<unknown>) => records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n"

/** Records for one agent's wire. */
const wire = (agentId: string) => {
  let step = 0
  let stepUuid = ""
  let n = 0
  const uuid = (kind: string) => `${agentId}-${kind}-${String(++n).padStart(4, "0")}`
  const loop = (s: number, event: object) => ({ type: "context.append_loop_event", agentId, event, time: t(s) })
  const usage = (input: number, output: number, cacheRead: number) => ({ inputOther: input, output, inputCacheRead: cacheRead, inputCacheCreation: 0 })
  const calls = new Map<string, string>()
  return {
    metadata: (s: number) => ({ type: "metadata", protocol_version: "1.5", created_at: t(s) }),
    config: (s: number, profileName: string) => ({
      type: "config.update",
      agentId,
      modelAlias: model,
      profileName,
      thinkingEffort: "high",
      systemPrompt: "You are Kimi Code, an interactive coding agent.",
      environmentDisclosure: { cwd, osKind: "Linux", shellName: "bash" },
      time: t(s)
    }),
    prompt: (s: number, text: string, origin: object, turnId: number) => [
      { type: "turn.prompt", agentId, input: [{ type: "text", text }], origin, promptId: `prompt-${agentId}-${turnId}`, turnId, time: t(s) },
      { type: "context.append_message", agentId, message: { role: "user", content: [{ type: "text", text }], toolCalls: [], origin, id: `msg-${agentId}-${turnId}` }, time: t(s) }
    ],
    message: (s: number, message: object) => ({ type: "context.append_message", agentId, message: { toolCalls: [], ...message }, time: t(s) }),
    /** `step.begin` then the requester's `usage.record`, as the engine writes them. */
    begin: (s: number, input: number, output: number, cacheRead: number) => {
      step += 1
      stepUuid = uuid("step")
      return [
        loop(s, { type: "step.begin", uuid: stepUuid, turnId: "0", step }),
        { type: "usage.record", agentId, model, usage: usage(input, output, cacheRead), usageScope: "turn", time: t(s) }
      ]
    },
    part: (s: number, part: object) => loop(s, { type: "content.part", uuid: uuid("part"), turnId: "0", step, stepUuid, part }),
    call: (s: number, toolCallId: string, name: string, args: object, display?: object) => {
      const callUuid = uuid("call")
      calls.set(toolCallId, callUuid)
      return loop(s, { type: "tool.call", uuid: callUuid, turnId: "0", step, stepUuid, toolCallId, name, args, ...(display !== undefined ? { display } : {}) })
    },
    result: (s: number, toolCallId: string, result: object) =>
      loop(s, { type: "tool.result", parentUuid: calls.get(toolCallId), toolCallId, result: { ...result, durationMs: 40 } }),
    end: (s: number, finishReason: string, input: number, output: number, cacheRead: number) =>
      loop(s, {
        type: "step.end",
        uuid: stepUuid,
        turnId: "0",
        step,
        finishReason,
        usage: usage(input, output, cacheRead),
        llmFirstTokenLatencyMs: 300,
        llmStreamDurationMs: 900,
        messageId: `chatcmpl-${agentId}-${step}`,
        providerFinishReason: finishReason
      }),
    ended: (s: number) => ({ type: "turn.ended", agentId, turnId: 0, reason: "completed", durationMs: 1000 * s, time: t(s) })
  }
}

export const generate = (): void => {
  rmSync(home, { recursive: true, force: true })
  const homeOnDisk = "/home/demo/.kimi-code"
  const bucket = workDirKey(cwd)
  const sessionDir = join(home, "sessions", bucket, KIMI_SESSION)
  const sessionDirOnDisk = `${homeOnDisk}/sessions/${bucket}/${KIMI_SESSION}`

  // Decoys: Kimi Code keeps API keys and OAuth tokens here. The adapter only walks `sessions/`.
  write(join(home, "config.toml"), `default_model = "${model}"\n\n[providers.kimi]\ntype = "kimi"\napi_key = "sk-${KIMI_DECOY_TOKEN}"\n`)
  write(
    join(home, "credentials", "kimi-code.json"),
    JSON.stringify({ access_token: KIMI_DECOY_TOKEN, refresh_token: "FAKE-refresh", expires_at: 1790000000 }, null, 2)
  )
  write(join(home, "session_index.jsonl"), jsonl([{ sessionId: KIMI_SESSION, sessionDir: sessionDirOnDisk, workDir: cwd }]))

  write(
    join(sessionDir, "state.json"),
    JSON.stringify(
      {
        id: KIMI_SESSION,
        version: 2,
        cwd,
        createdAt: t(0),
        updatedAt: t(18),
        archived: false,
        title: "Add README usage section",
        titleKind: "generated",
        isCustomTitle: false,
        lastPrompt: prompt,
        lastTurnReason: "completed",
        agents: {
          main: { homedir: `${sessionDirOnDisk}/agents/main`, type: "main", parentAgentId: null },
          [KIMI_SUBAGENT_AGENT]: {
            homedir: `${sessionDirOnDisk}/agents/${KIMI_SUBAGENT_AGENT}`,
            type: "sub",
            parentAgentId: "main",
            labels: { parentAgentId: "main", profileName: "explore" }
          }
        },
        custom: {}
      },
      null,
      2
    )
  )

  const usageMd = "# Usage\n\nRun `npm start`.\n"
  const m = wire("main")
  write(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    jsonl([
      m.metadata(0),
      m.config(0, "agent"),
      ...m.prompt(1, prompt, { kind: "user" }, 0),
      // Context the harness injected in the user role.
      m.message(1, {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>\nToday's date is 2026-09-01. The working directory is /work/demo.\n</system-reminder>" }],
        origin: { kind: "injection", variant: "date_change" },
        id: "msg-main-injection-1"
      }),

      ...m.begin(2, 1800, 60, 0),
      m.part(2, { type: "think", think: "I should read the README first.", encrypted: "c2lnbmF0dXJl" }),
      m.call(2, "tool_read_1", "Read", { path: "README.md" }, { kind: "file_io", operation: "read", path: `${cwd}/README.md` }),
      m.result(3, "tool_read_1", { output: "     1\t# Demo\n     2\tA demo project.\n", isError: false }),
      m.end(3, "tool_calls", 1800, 60, 0),

      ...m.begin(4, 300, 80, 1700),
      m.call(4, "tool_edit_1", "Edit", { path: "README.md", old_string: "A demo project.", new_string: "A demo project.\n\n## Usage\n\nRun `npm start`." }, {
        kind: "file_io",
        operation: "edit",
        path: `${cwd}/README.md`,
        before: "A demo project.",
        after: "A demo project.\n\n## Usage\n\nRun `npm start`."
      }),
      m.result(5, "tool_edit_1", { output: "Replaced 1 occurrence in README.md" }),
      { type: "file_history.tracked", agentId: "main", turnId: 0, path: `${cwd}/README.md`, entry: { key: "file-history/v1/0001", version: 1, size: 24 }, time: t(5) },
      m.end(5, "tool_calls", 300, 80, 1700),
      "{\"type\":\"context.append_loop_event\",\"agentId\":\"main\",\"event\":{\"type\":\"tool.ca", // malformed

      ...m.begin(6, 200, 40, 1900),
      m.call(6, "tool_bash_1", "Bash", { command: "npm test", description: "Run tests", timeout: 120 }, {
        kind: "command",
        command: "npm test",
        cwd,
        description: "Run tests",
        language: "bash"
      }),
      // A failed foreground command: the exit code exists only in the result text.
      m.result(7, "tool_bash_1", { output: "1 failing: usage section missing example\nCommand failed with exit code: 1.", isError: true }),
      m.end(7, "tool_calls", 200, 40, 1900),
      { type: "session.future_record", agentId: "main", somethingNew: true, time: t(7) }, // unknown

      ...m.begin(8, 250, 50, 2000),
      m.call(8, "tool_agent_1", "Agent", { description: "Find TODO comments", prompt: "Find all TODO comments in src/.", subagent_type: "explore" }, {
        kind: "agent_call",
        agent_name: "explore",
        prompt: "Find all TODO comments in src/."
      }),
      {
        type: "subagent.spawned",
        subagentId: KIMI_SUBAGENT_AGENT,
        subagentName: "explore",
        parentToolCallId: "tool_agent_1",
        parentAgentId: "main",
        callerAgentId: "main",
        description: "Find TODO comments",
        runInBackground: false,
        model,
        thinkingEffort: "high",
        time: t(8)
      },
      { type: "subagent.started", subagentId: KIMI_SUBAGENT_AGENT, time: t(9) },
      { type: "subagent.completed", subagentId: KIMI_SUBAGENT_AGENT, resultSummary: "There are no TODO comments in src/.", time: t(11) },
      m.result(12, "tool_agent_1", {
        output: [
          `agent_id: ${KIMI_SUBAGENT_AGENT}`,
          "actual_subagent_type: explore",
          "status: completed",
          "stop_reason: completed",
          "",
          "[summary]",
          "There are no TODO comments in src/.",
          "",
          `resume_hint: To continue or recover this same subagent later, call Agent(resume="${KIMI_SUBAGENT_AGENT}", prompt="...").`
        ].join("\n"),
        isError: false
      }),
      m.end(12, "tool_calls", 250, 50, 2000),

      ...m.begin(13, 260, 90, 2100),
      m.call(13, "tool_write_1", "Write", { path: "docs/usage.md", content: usageMd }, {
        kind: "file_io",
        operation: "write",
        path: `${cwd}/docs/usage.md`,
        content: usageMd
      }),
      m.result(14, "tool_write_1", { output: `Wrote ${Buffer.byteLength(usageMd)} bytes to docs/usage.md` }),
      m.end(14, "tool_calls", 260, 90, 2100),

      ...m.begin(15, 210, 40, 2300),
      m.call(15, "tool_bash_2", "Bash", { command: "npm test", description: "Run tests again" }, { kind: "command", command: "npm test", cwd, language: "bash" }),
      m.result(16, "tool_bash_2", { output: "2 passing\n", isError: false }),
      m.end(16, "tool_calls", 210, 40, 2300),

      ...m.begin(17, 220, 30, 2400),
      m.part(17, { type: "text", text: reply }),
      m.end(17, "completed", 220, 30, 2400),
      m.ended(18)
    ])
  )

  const a = wire(KIMI_SUBAGENT_AGENT)
  write(
    join(sessionDir, "agents", KIMI_SUBAGENT_AGENT, "wire.jsonl"),
    jsonl([
      a.metadata(9),
      a.config(9, "explore"),
      // The parent agent is the subagent's principal.
      ...a.prompt(9, "Find all TODO comments in src/.", { kind: "system_trigger", name: "subagent" }, 0),
      ...a.begin(10, 900, 20, 0),
      a.call(10, "tool_grep_1", "Grep", { pattern: "TODO", path: "src", output_mode: "content" }),
      a.result(10, "tool_grep_1", { output: "No matches found.", isError: false }),
      a.end(10, "tool_calls", 900, 20, 0),
      ...a.begin(11, 100, 15, 900),
      a.part(11, { type: "text", text: "There are no TODO comments in src/." }),
      a.end(11, "completed", 100, 15, 900),
      a.ended(11)
    ])
  )

  // Session sidecars that are not wires.
  write(join(sessionDir, "agents", "main", "blobs", "0".repeat(64)), "not a session\n")
  write(join(sessionDir, "agents", "main", "tasks", "bash-0a1b2c3d.json"), JSON.stringify({ taskId: "bash-0a1b2c3d", kind: "process", status: "completed" }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate()
  console.log(`generated kimi fixtures in ${home}`)
}
