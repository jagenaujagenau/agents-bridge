/**
 * Writes the sanitized GitHub Copilot CLI fixture for the spec §63 scenario:
 *
 *   user asks to add a Usage section to README.md → agent reads README.md →
 *   edits it → runs `npm test` (fails) → creates docs/usage.md →
 *   runs `npm test` (passes) → replies.
 *
 * Plus one malformed line, one unknown event type, one injected notice (a hidden skill
 * prompt) and an inline `task` subagent whose events carry `agentId`, as Copilot records
 * them. Shapes follow `@github/copilot-sdk` `session-events.d.ts` (CLI 1.0.98) and the
 * 1.0.62 runtime. Nothing is copied from real history.
 *
 * Run: node packages/adapter-copilot/test/generate-fixture.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const COPILOT_SESSION = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c"
/** Copilot uses the spawning `task` call's ID as the subagent's `agentId`. */
export const COPILOT_SUBAGENT = "call_task_todos"

const home = fileURLToPath(new URL("../../testing/fixtures/copilot/", import.meta.url))
const cwd = "/work/demo"
const prompt = "Add a Usage section to README.md and make sure the tests pass."
const reply = "Added a Usage section to README.md and docs/usage.md. Tests pass."
const model = "claude-sonnet-4.5"
const t = (s: number) => `2026-09-01T10:00:${String(s).padStart(2, "0")}.000Z`

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

export const generateCopilotFixture = () => {
  rmSync(home, { recursive: true, force: true })
  const dir = join(home, "session-state", COPILOT_SESSION)
  let n = 0
  let previous: string | null = null
  const event = (s: number, type: string, data: object, agentId?: string) => {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
    const record = { type, data, id, timestamp: t(s), parentId: previous, ...(agentId !== undefined ? { agentId } : {}) }
    previous = id
    return JSON.stringify(record)
  }
  let turn = 0
  const turnStart = (s: number) => event(s, "assistant.turn_start", { turnId: String(turn), interactionId: "int-1" })
  const turnEnd = (s: number) => event(s, "assistant.turn_end", { turnId: String(turn++) })
  const call = (s: number, toolCallId: string, name: string, args: object, extra: object = {}, agentId?: string) => [
    event(s, "assistant.message", {
      messageId: `msg-${toolCallId}`,
      content: "",
      model,
      toolRequests: [{ toolCallId, name, arguments: args, type: "function" }],
      outputTokens: 30,
      apiCallId: `api-${toolCallId}`,
      ...(agentId === undefined ? { turnId: String(turn), interactionId: "int-1" } : { parentToolCallId: agentId }),
      ...extra
    }, agentId),
    event(s, "tool.execution_start", {
      toolCallId,
      toolName: name,
      arguments: args,
      model,
      ...(agentId === undefined ? { turnId: String(turn) } : { parentToolCallId: agentId })
    }, agentId)
  ]
  const done = (s: number, toolCallId: string, success: boolean, result: object, extra: object = {}, agentId?: string) =>
    event(s, "tool.execution_complete", {
      toolCallId,
      success,
      model,
      result,
      ...(agentId === undefined ? { turnId: String(turn) } : { parentToolCallId: agentId }),
      ...extra
    }, agentId)

  const lines = [
    event(0, "session.start", {
      sessionId: COPILOT_SESSION,
      version: 1,
      producer: "copilot-agent",
      copilotVersion: "1.0.98",
      startTime: t(0),
      selectedModel: model,
      context: { cwd, gitRoot: cwd, branch: "main", headCommit: "0123456789abcdef0123456789abcdef01234567", repository: "acme/demo", hostType: "github" }
    }),
    event(0, "system.message", { role: "system", content: "You are the GitHub Copilot CLI, a terminal assistant." }),
    event(1, "user.message", {
      content: prompt,
      transformedContent: `<current_datetime>${t(1)}</current_datetime>\n\n${prompt}`,
      attachments: [],
      agentMode: "interactive",
      interactionId: "int-1"
    }),
    // A skill's instructions, injected in the user role but hidden from the user's timeline.
    event(1, "user.message", { content: "<skill-context name=\"testing\">\nRun the test suite with npm test.\n</skill-context>", source: "skill-testing" }),
    event(1, "permission.requested", { requestId: "perm-1", permissionRequest: { kind: "read", path: `${cwd}/README.md` } }),

    turnStart(2),
    ...call(2, "call_view", "view", { path: `${cwd}/README.md` }, { reasoningText: "I should read the README first." }),
    done(3, "call_view", true, { content: "1. # Demo\n2. A demo project.", detailedContent: "# Demo\nA demo project." }),
    turnEnd(3),

    turnStart(4),
    ...call(4, "call_edit", "edit", { path: `${cwd}/README.md`, old_str: "A demo project.", new_str: "A demo project.\n\n## Usage\n\nRun `npm start`." }),
    // 1.0.9x records the committed mutations; the edit is read from them.
    done(5, "call_edit", true, { content: `File ${cwd}/README.md updated with changes.` }, { fileEdits: [{ kind: "edit", path: `${cwd}/README.md` }] }),
    turnEnd(5),
    "{\"type\":\"assistant.message\",\"data\":{\"messageId\":\"broken", // malformed

    turnStart(6),
    ...call(6, "call_test1", "bash", { command: "npm test", description: "Run tests", mode: "sync" }),
    // 1.0.62 records the exit code only in the result text.
    done(7, "call_test1", true, { content: "1 failing: usage section missing example\n<shellId: 1 completed with exit code 1>" }),
    turnEnd(7),
    event(7, "session.future_event", { something: true }), // unknown type

    // An inline subagent: its events carry the spawning call's ID as agentId.
    turnStart(8),
    ...call(8, COPILOT_SUBAGENT, "task", {
      description: "Find TODO comments",
      prompt: "Find all TODO comments in src/.",
      agent_type: "explore",
      name: "todo-finder"
    }),
    event(8, "subagent.started", {
      toolCallId: COPILOT_SUBAGENT,
      agentName: "explore",
      agentDisplayName: "Explore Agent",
      agentDescription: "Fast codebase exploration",
      model: "claude-haiku-4.5"
    }, COPILOT_SUBAGENT),
    ...call(9, "call_grep", "grep", { pattern: "TODO", path: "src" }, { model: "claude-haiku-4.5" }, COPILOT_SUBAGENT),
    done(10, "call_grep", true, { content: "No matches found." }, {}, COPILOT_SUBAGENT),
    event(11, "assistant.message", {
      messageId: "msg-sub-reply",
      content: "There are no TODO comments in src/.",
      model: "claude-haiku-4.5",
      toolRequests: [],
      outputTokens: 12,
      apiCallId: "api-sub-reply",
      parentToolCallId: COPILOT_SUBAGENT
    }, COPILOT_SUBAGENT),
    event(11, "subagent.completed", {
      toolCallId: COPILOT_SUBAGENT,
      agentName: "explore",
      agentDisplayName: "Explore Agent",
      model: "claude-haiku-4.5",
      totalToolCalls: 1,
      totalTokens: 900,
      durationMs: 3000
    }, COPILOT_SUBAGENT),
    done(12, COPILOT_SUBAGENT, true, { content: "There are no TODO comments in src/." }),
    turnEnd(12),

    turnStart(13),
    ...call(13, "call_create", "create", { path: `${cwd}/docs/usage.md`, file_text: "# Usage\n\nRun `npm start`.\n" }),
    done(14, "call_create", true, { content: `Created file ${cwd}/docs/usage.md with 27 characters` }),
    turnEnd(14),

    turnStart(15),
    ...call(15, "call_test2", "bash", { command: "npm test", description: "Run tests again", mode: "sync" }),
    done(16, "call_test2", true, { content: "2 passing\n<shellId: 2 completed with exit code 0>" }, { shellExecution: { exitCode: 0 } }),
    turnEnd(16),

    turnStart(17),
    event(17, "assistant.message", {
      messageId: "msg-reply",
      content: reply,
      model,
      toolRequests: [],
      outputTokens: 18,
      apiCallId: "api-reply",
      turnId: String(turn),
      interactionId: "int-1"
    }),
    turnEnd(18),
    event(19, "session.shutdown", {
      shutdownType: "routine",
      totalApiDurationMs: 9000,
      sessionStartTime: Date.parse(t(0)),
      codeChanges: { linesAdded: 6, linesRemoved: 0, filesModified: [`${cwd}/README.md`, `${cwd}/docs/usage.md`] },
      modelMetrics: {
        [model]: { requests: { count: 6, cost: 6 }, usage: { inputTokens: 52000, outputTokens: 168, cacheReadTokens: 40000, cacheWriteTokens: 0 } }
      },
      currentModel: model
    })
  ]
  write(join(dir, "events.jsonl"), lines.join("\n") + "\n")
  write(
    join(dir, "workspace.yaml"),
    [
      `id: ${COPILOT_SESSION}`,
      `cwd: ${cwd}`,
      `git_root: ${cwd}`,
      "repository: acme/demo",
      "host_type: github",
      "branch: main",
      "name: Add README usage section",
      "user_named: false",
      "summary_count: 0",
      `created_at: ${t(0)}`,
      `updated_at: ${t(19)}`,
      ""
    ].join("\n")
  )
  // Session artifacts Bridge must not read as sessions.
  write(join(dir, "plan.md"), "# Plan\n\n- [x] Add usage section\n")
  write(join(dir, "checkpoints", "index.md"), "# Checkpoints\n")
  // The flat layout of early releases, no longer read by Copilot itself.
  write(join(home, "session-state", "legacy-flat-session.jsonl"), "{\"type\":\"session.start\",\"data\":{\"sessionId\":\"legacy\"}}\n")
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateCopilotFixture()
  console.log(`generated copilot fixture in ${home}`)
}
