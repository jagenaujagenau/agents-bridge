# Bridge — Reference Findings (pre-implementation)

Goal these notes serve (spec §63, M2, §94):

```text
Claude Code history ─┐
                     ├─> identical useful Bridge primitives
Codex history ───────┘
with no provider-specific logic leaking into the consumer.
```

Sources read:

- `tmp/bridge-references/ai-session-search`: `providers/{mod,claude,codex,spawn}.rs`, `files.rs`, `tail.rs`, `config.rs`, `models.rs`. It covers historical discovery and parsing for many providers.
- `tmp/bridge-references/agent-harness`: `events.rs`, `harness.rs`, `program_path.rs`, `{claude,codex}/parser.rs`. It covers harness support: detection, capabilities and a neutral live event model.
- `tmp/bridge-references/agent-client-protocol`: `schema/v1/schema.json`. It shows the ACP vocabulary Bridge will meet in M6.
- Local history on this machine, looking only at the shape of records and never their content: 31 Claude project dirs and 21 Codex rollouts under `~/.codex/sessions`. Counts below marked *(local)* come from these files.

---

## 1. What to borrow

| From | Borrow | Bridge location |
|---|---|---|
| ai-session-search | Walk the roots once. A missing root counts as an empty state, not an error. Every other failure becomes a **warning that names the path and the operation**. | `listSessions`, `ImportWarning` |
| ai-session-search | Bind the session ID **once** per file. A later record must never retarget the file to another ID. | Claude + Codex normalizers |
| ai-session-search | Subagent identity is `parent/run-suffix` and parent links are typed. | `Session.parentSessionId` |
| ai-session-search | Stage a file mutation until its **correlated result proves success**. | `file.changed` derivation |
| ai-session-search | Classify harness-injected text as its own kind instead of treating it as user prose. | new canonical kind (§5.2) |
| ai-session-search | Cheap `SourceFile {path, mtime, size}` descriptors, with sidecar mtime and size folded in. | `SessionDescriptor` + M5 fingerprints |
| ai-session-search | Parse a tail from a byte offset, reusing the same per-line parser, plus a head fingerprint. | M5 incremental imports |
| agent-harness | A `ToolKind` class (`read/write/edit/delete/move/search/execute/fetch/other`) that aligns 1:1 with ACP. | add to `tool.started` (§5.1) |
| agent-harness | `Features` default to **all off**, so an adapter only claims what it implements. | `HarnessCapabilities` |
| agent-harness | `Readiness {installed, version, authConfigured, error, details}` built from a version probe. It never reads credentials. | `DetectionResult` |
| agent-harness | Resolve a program path through an augmented PATH (nvm/Homebrew), because GUI launches get a minimal PATH. | `detect` in platform-node |

Don't borrow:

- ai-session-search's `Role` + `MessageKind` + `Authorship` triple. It is shaped by search analytics and is richer than Bridge needs.
- agent-harness's delta-streaming `Text`. It is live-only, while history is already whole.

---

## 2. Discovery

### Claude Code

- **Root:** `~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-uuid>.jsonl`.
- **Skip:**
  - any path containing a `memory` component
  - `journal.jsonl` under a `subagents/` directory, because it is a workflow log and not a session
- **Subagents:** two layouts.
  - `<parent-uuid>/subagents/[workflows/wf_x/]agent-<id>.jsonl` gives ID `<parent>/<nested path stem>`.
  - A flat `agent-<id>.jsonl` beside the parent gives ID `<parent from record sessionId>/agent-<id>`.
  - Every record in a subagent file carries the **parent's** `sessionId`, so it must never bind the child's ID.
  - An optional sidecar `agent-<id>.meta.json` holds `agentType` and `description`.
- **Session ID:** file stem, or the first record's `session_id`/`sessionId`.
- **cwd:** first record that has one.
- **Title:** in priority order:
  1. sidecar description
  2. `last-prompt` record
  3. last substantive user text
  4. first substantive user text

  *(local)* There are also `ai-title` and `agent-name` record types, which ai-session-search does not use. Prefer `aiTitle`.
- **Claude Desktop** (`local-agent-mode-sessions/**/audit.jsonl` + a `<dir>.json` sidecar) is a separate provider. Leave it out of M1.

### Codex

- **Root:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. `CODEX_HOME` is the parent of the sessions root.
- **Session ID:** the **first** `session_meta.payload.id`. Fall back to a UUID regex on the filename.
  - A forked or resumed rollout writes a **second** `session_meta` with the parent's ID. ai-session-search's comment says binding it anyway overwrote 65 of 414 sessions.
  - *(local)* 7 of 21 files have 2–3 `session_meta` records.
- **Sidecars:** both are optional, read-only, and failures in them only produce warnings.
  - `state_5.sqlite` table `threads`: `title`, `first_user_message`, `source`, `git_*`, `cli_version`, `model`, `agent_nickname`, and more. Columns vary by version: probe them with `pragma table_info` and select `null as col` for missing ones.
  - `session_index.jsonl`: fallback titles.
- **Subagents:** `threads.source` is a JSON string, either `{"subagent":{"thread_spawn":{"parent_thread_id","agent_nickname"}}}` or `{"subagent":{"other":"guardian"}}`.
- **Implication for Effect:** the Codex adapter needs a SQLite read for metadata only. Make it an optional enricher behind a Layer, so that `events()` works from JSONL alone.

### Shared rules for both

- Canonical session ID is `<harness>:<nativeId>`, and subagents are `<harness>:<parent>/<suffix>`. It is deterministic, which satisfies §33.
- A malformed JSONL line increments a counter and produces **one** summarised warning ("skipped N malformed records"). It never fails the session.
- Decode lines lossily: an invalid UTF-8 byte becomes U+FFFD, so one bad byte cannot lose the session.
- Stream line by line. ai-session-search saw a 536 MB session need about 1.5 GB of RAM when the file was read whole.

---

## 3. Record formats: the differences that matter

### Claude Code *(verified locally)*

- Record `type` values seen: `user`, `assistant`, `attachment`, `last-prompt`, `ai-title`, `agent-name`, `atis-latch`, `queue-operation`, plus `system` and `summary` in other files. Everything except `user` and `assistant` is metadata or unknown.
- **One API message is split across several lines.** Assistant records with the same `message.id` repeat on 2–3 lines, one content block per line, each with its own `uuid`.
  - Decide whether `agent.message` is per block or coalesced. **Recommendation:** one canonical event per content block, `nativeEventId = uuid`. That keeps event IDs stable without lookahead.
- **Tool results arrive inside `role:user` records** as `tool_result` blocks with `tool_use_id` and `is_error`. They are never user messages.
  - One user record can **mix** real text and tool results; ai-session-search has an explicit `mixed` path for this.
  - Split it into `user.message` plus `tool.completed`.
- The top-level `toolUseResult` holds structured output.
  - *Bash* result: `{stdout, stderr, interrupted, isImage, noOutputExpected}`, sometimes with `returnCodeInterpretation` or `backgroundTaskId`.
  - **There is no numeric exit code.** `command.completed.exitCode` is `unknown` for Claude, while failure is `is_error`.
- **Harness notices** are not user prose:
  - `isMeta: true`
  - text starting `<task-notification`, `<local-command-stdout|stderr|caveat>`
  - `<command-name>` slash-command markup, which should be stripped to `/name args`
- **Compaction:** `isCompactSummary: true` on a `role:user` record.
- `thinking` blocks are real, provider-exposed reasoning.
- **No session-end record.** The session's status cannot be `known`.

### Codex *(verified locally)*

Record types and counts, summed over all 21 rollouts:

```text
response_item: message 249, reasoning 218, function_call 382, function_call_output 382,
               custom_tool_call(apply_patch) 79, custom_tool_call_output 79,
               web_search_call 6, tool_search_call/output 1
event_msg:     token_count 404, exec_command_end 163, agent_message 162, patch_apply_end 73,
               mcp_tool_call_end 66, user_message 42, task_started 41, task_complete 40,
               context_compacted 2, turn_aborted 1, thread_name_updated 1
other:         turn_context 43, session_meta 21, compacted 2
```

- **The same fact is recorded twice.**
  - `response_item` is what the model saw: `message`, `function_call`, and so on.
  - `event_msg` is what the UI showed: `user_message`, `agent_message`, `exec_command_end`, `patch_apply_end`.
  - A normalizer that maps both **emits duplicates**. Pick one source per fact:
    - messages and tool calls: `response_item`
    - command exit code and duration: `exec_command_end`, joined on `call_id`
    - patch success and file list: `patch_apply_end.changes`, joined on `call_id`
- **No native event IDs.** 0 `response_item`s have `payload.id`; all tool items have `call_id`.
  - Event IDs therefore have to use the §33 fallback: `hash(harness, session, lineIndex, type, derivationIndex)`. This is stable only because rollouts are append-only.
- Tool names: `exec_command {cmd, workdir, yield_time_ms, …}` (288), `apply_patch` (raw patch text in `input`), `js {code, title}`, `write_stdin {session_id, chars}`. There is no `shell` in local data, but older builds used it, so map both.
- The `function_call_output` string starts with a text header: `Command: …\nChunk ID\nWall time\nProcess exited with code N\nOutput:`. Prefer `exec_command_end.exit_code` over parsing it.
- **Reasoning:** all 218 local `reasoning` items have `summary: []` plus `encrypted_content`.
  - Emit nothing when the summary is empty (§13: never reconstruct).
  - Emit `agent.reasoning{representation:"summary"}` when it is non-empty.
- **Injected context arrives as `role:user`:** `<environment_context`, `# AGENTS.md instructions`, `<goal_context`, `<codex_internal_context`, `<hook_prompt`, `<turn_aborted`, `The following is the Codex agent history`. These are the same category as Claude's harness notices.
- **Turns are explicit** (`task_started`/`task_complete` carry `turn_id` and `duration_ms`; `turn_aborted` carries `reason`). There is still no session-end record.

---

## 4. Mapping table (the equivalence contract)

| Canonical | Claude Code | Codex | Certainty |
|---|---|---|---|
| `session.started` | first record's `timestamp` | first `session_meta` | known |
| `user.message` | `user` text blocks, excluding tool_result, notices and compaction | `response_item.message role=user`, excluding injected context | known |
| `agent.message` | `assistant` `text` block | `response_item.message role=assistant` | known |
| `agent.reasoning` | `thinking` block → `provider_exposed` | `reasoning.summary[]` non-empty → `summary` | known |
| `tool.started` | `tool_use {id,name,input}` | `function_call`/`custom_tool_call {call_id,name,arguments/input}` | known |
| `tool.completed` / `tool.failed` | `tool_result` by `tool_use_id`, `is_error` | `*_output` by `call_id`; failure from `exec_command_end.exit_code≠0` / `patch_apply_end.success` | known |
| `command.started` | `Bash.input.command` | `exec_command.cmd` (+`workdir`) / `shell.command` | known |
| `command.completed` | stdout/stderr from `toolUseResult`, **exitCode absent** | `exec_command_end {exit_code, stdout, stderr, duration}` | known; exitCode for Claude unknown |
| `file.read` | `Read.file_path` | none structured; would have to be inferred from `cmd` (`cat`, `sed -n`) | known / inferred |
| `file.changed` | `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, emitted only after a successful result | `apply_patch` hunks, only after `patch_apply_end.success` | known |
| `session.completed` | none | none (`task_complete` is per turn) | **inferred at best** |

Tool-kind mapping (agent-harness, extended for history):

- **Claude:**
  - `Read|NotebookRead` → read
  - `Write` → write
  - `Edit|MultiEdit|NotebookEdit` → edit
  - `Grep|Glob|WebSearch` → search
  - `WebFetch` → fetch
  - `Bash|BashOutput` → execute
  - everything else → other
- **Codex:**
  - `exec_command|shell|write_stdin` → execute
  - `apply_patch` → edit
  - `web_search_call` → search
  - `mcp__*`, `js` and everything else → other

  agent-harness maps its **live** `exec --json` item types (`command_execution`, `file_change`), not rollout names. **Rollout names need their own table.**

---

## 5. Changes these findings force in `BRIDGE_EFFECT_V4_SPEC.md`

Without these, a consumer has to branch on the provider to render or count things correctly.

1. **Add `toolKind` to `tool.started`** (ACP-aligned literals). Otherwise a generic tool view has to know that `Bash` and `exec_command` are the same thing, which is exactly the §91 leak.
2. **Represent injected or harness text canonically.** Both providers inject large `role:user` payloads.
   - If they become `user.message`, every consumer sees fake prompts.
   - If they are dropped, hook feedback is lost.
   - Options: a `harness.notice` event, or an `origin: "human" | "agent" | "harness"` field on `user.message`. The second also covers subagent prompts, which are written by an agent.
3. **Session end must not be fabricated.** Neither history format records one.
   - Recommendation: `Session.status = "unknown"` for history, and `session.completed` is either omitted or emitted only with `certainty: "inferred"`.
   - Either way, §66's required event list needs updating. **Needs your decision.**
4. **Add optional turn events** (`turn.started`/`turn.completed`). Codex has them natively, and for Claude they are inferable at each user prompt. Replay-style consumers need turns; defer only if you accept that consumers will derive them.
5. **Add a `compaction` event** (Claude `isCompactSummary`, Codex `compacted`/`context_compacted`). Otherwise the summary shows up as a user message.
6. **Make `command.completed.exitCode` explicitly optional per provider**, and add `interrupted?: boolean`. Record an absent exit code as unknown, never as `0`.
7. **Pick one source per fact** (§3 Codex dedupe) and add it to §88 as an authoring rule: "each canonical fact comes from exactly one native record; joins by native call ID."
8. **Stable IDs:** keep §33 as written, but document that Codex *always* uses the line-index fallback and Claude uses the per-line `uuid`. Also document that rewrites break the fallback, which is why M5 needs a head fingerprint.
9. **Sessions list:** add `parentSessionId` / `agentLabel` to `SessionDescriptor` (not only to `Session`), so a subagent tree can be rendered without loading events.
10. **Detection:** extend `DetectionResult` with `authConfigured?` and `error?`, taken from agent-harness `Readiness`. Historical access doesn't need auth, so readiness for history should be `historyAvailable` alone.

---

## 6. Proof plan for the first goal

1. Build fixtures by hand in both native formats for the §63 scenario. Sanitised, never copied from `~/.claude` or `~/.codex`:
   - user asks to edit README
   - agent reads the file
   - agent edits it
   - agent runs tests (one pass, one failure)
   - an injected-context record
   - one malformed line
2. Golden JSONL per adapter.
3. **Equivalence test:** project both streams to `(type, toolKind, command, path, ok)` after dropping `id`, `sequence`, `timestamp`, `source` and `certainty`. Assert the two projections are equal. The only allowed difference is listed exceptions such as Claude `exitCode: unknown`.
4. **Architectural test:** a tiny consumer module that renders both streams and a lint or grep asserting it never references `harness.id`, `source.provider` or native tool names.
5. **Contract suite** (§65), run per adapter:
   - run twice and get identical IDs
   - sequence is monotonic
   - one malformed line yields one warning and the session still loads
   - a forked Codex file keeps its own ID
   - a Claude subagent file keeps its own ID and links to its parent
