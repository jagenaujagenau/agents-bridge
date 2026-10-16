# Writing a Harness Adapter

An adapter turns one harness's native history into canonical emissions. It needs no knowledge of
Replay, the CLI, or storage.

## The contract

```ts
interface HarnessAdapterShape {
  readonly id: HarnessId
  readonly name: string
  readonly capabilities: HarnessCapabilities          // start from noCapabilities; claim only what you implement
  readonly detect: Effect<DetectionResult>             // never fails; problems go to `notes`
  readonly listSessions: (options?) => Stream<SessionDescriptor, SessionReadError>
  readonly resolve: (id: SessionId) => Effect<SessionDescriptor, SessionNotFound | SessionReadError>
  readonly read: (descriptor) => Stream<Emission, SessionReadError>
}
```

Declare it as a `Context.Service` with `static make` and `static layer`. Adapters depend only on
`FileSystem`, `Path`, `HostEnvironment` and `VersionProbe` (plus `SqliteReader` for database-backed
harnesses). Nothing Node-specific.

## Building blocks in `@agentbridge/core`

| Helper | Use |
|---|---|
| `harnessRoot("ENV_OVERRIDE", ".dir")` | Locate history: the override variable if set, else a path under `HOME`. |
| `detectHarness({ executables, extraDirs, historyPaths })` | Standard detection: PATH lookup, `--version` probe, history presence. Never reads file contents. |
| `makeFileHistoryAdapter({ roots, classify, headLines, inspect, enrich, priority, read })` | Discovery, listing and resolution for harnesses with one file per session. You write `classify` (path → candidate) and the normalizer. |
| `SqliteReader.rows(db, sql, params)` | Read-only, scoped row streaming for database-backed harnesses. |
| `readLines(fs, harness, path)` | Line-by-line streaming with lossy UTF-8. |
| `makeLineDecoder` / `makeRecordDecoder` | JSON → provider schema, classified as `Record`, `Skip` (ignored type), `Unknown` or `Malformed`. |
| `warnUndecodable(scope, decoded, name)` | Standard warnings for unknown and malformed records. |
| `RecordScope` | Emit events for one native record with stable IDs, provenance and normalized timestamps. |
| `emitPlan(scope, list, contentKey, link)` | Todo-tool payloads → `plan.updated`, tolerant of real status variants. |
| `tokenCount`, `usageFields` | Build `usage.recorded` without inventing zeroes. |
| `textOf`, `stringProp`, `titleFrom` | Small helpers for untyped provider payloads. |

Harness IDs and their override variables:

| Harness | ID | History | Override |
|---|---|---|---|
| Claude Code | `claude-code` | `~/.claude/projects/**.jsonl` | `CLAUDE_CONFIG_DIR` |
| Codex | `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | `CODEX_HOME` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` (SQLite) | `OPENCODE_DATA_DIR`, `XDG_DATA_HOME` |
| pi | `pi` | `~/.pi/agent/sessions/<cwd>/<time>_<id>.jsonl` | `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` (flat) |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/<project>/chats/session-*.json` | `GEMINI_CLI_HOME` |
| Cursor | `cursor` | `~/.cursor/projects/<path>/agent-transcripts/**.jsonl` | `CURSOR_CONFIG_DIR` |
| Antigravity | `antigravity` | `~/.gemini/antigravity[-cli]/brain/<id>/.system_generated/logs/transcript[_full].jsonl` | `ANTIGRAVITY_HOME` |
| ACP recordings | `acp` | `~/.bridge/acp/<agent>/<session>.jsonl` | `BRIDGE_ACP_RECORDINGS` |
| oh-my-pi | `omp` | `~/.omp/agent/sessions/<dir>/<time>_<id>.jsonl` (subagents: `<time>_<id>/<AgentId>.jsonl`) | `OMP_CODING_AGENT_DIR`, `OMP_CODING_AGENT_SESSION_DIR`, `OMP_PROFILE` / `PI_PROFILE`, `PI_CONFIG_DIR`, `XDG_DATA_HOME` |
| Amp | `amp` | `~/.local/share/amp/threads/T-<uuid>.json` (written only up to 2026-03-31; newer threads are server-side) + `~/.bridge/amp/*.json` (`amp threads export`) | `AMP_DATA_HOME`, `XDG_DATA_HOME`, `BRIDGE_AMP_EXPORTS` |
| Factory Droid | `droid` | `~/.factory/sessions/<project>/<id>.jsonl` | `FACTORY_HOME_OVERRIDE` (replaces `HOME`) |
| GitHub Copilot CLI | `copilot` | `~/.copilot/session-state/<id>/events.jsonl` (+ `workspace.yaml`) | `COPILOT_HOME` |
| Qwen Code | `qwen-code` | `~/.qwen/projects/<cwd>/chats/<id>.jsonl` (+ `archive/`, `subagents/<id>/agent-*.jsonl`) | `QWEN_RUNTIME_DIR`, `QWEN_HOME` |
| Grok Build | `grok` | `~/.grok/sessions/<encoded-cwd>/<id>/updates.jsonl` (+ `summary.json`) | `GROK_HOME` |
| Kimi Code | `kimi` | `~/.kimi-code/sessions/<wd_slug_hash>/<session_id>/agents/<agent>/wire.jsonl` (+ `state.json`) | `KIMI_CODE_HOME` |
| Crush | `crush` | `<project>/.crush/crush.db` (SQLite, one per project; found via `<global data>/projects.json`) | `CRUSH_GLOBAL_DATA`, `XDG_DATA_HOME`, `LOCALAPPDATA`, `BRIDGE_CRUSH_PROJECTS` (extra projects or databases) |
| Goose | `goose` | `~/.local/share/goose/sessions/sessions.db` (SQLite) + legacy `sessions/<id>.jsonl` | `GOOSE_PATH_ROOT` (`<root>/data`), `XDG_DATA_HOME` |

## Rules

1. **Never decode provider data into canonical schemas.** unknown → provider schema → normalizer → canonical.
2. **Be lenient in provider schemas.** Unknown keys are ignored; unknown content blocks decode to a fallback.
3. **Unknown record types are warnings, not errors** (`unknown_record_type`). Known metadata-only
   types go in an explicit ignore list, so new types surface in `pnpm audit:local`.
4. **Malformed records are warnings** (`malformed_json`, `malformed_record`). A session always loads.
5. **Each canonical fact comes from exactly one native record.** Codex records messages twice
   (`response_item` and `event_msg`); Gemini echoes tool results as user turns. Read each fact once.
6. **Emit file effects only after a result proves success.** When a harness records no results
   (Cursor) or pairs results only by order (Antigravity), emit them with `certainty: "inferred"`.
7. **Never fabricate.** No `session.completed` without evidence, no `exitCode: 0` when the source
   has no exit code, no reconstructed reasoning, no invented timestamps.
8. **Bind the session ID once, from the file or row.** Records inside subagent or forked files may
   carry another session's ID.
9. **Classify injected text.** Content the harness put in the user role is `harness.notice`, not
   `user.message`. Client wrappers (`<user_query>`, `<USER_REQUEST>`, `## My request for Codex:`)
   are unwrapped.
10. **Interpret native tool names only in the normalizer's tool table**, mapping them to `ToolKind`.
11. **Stream.** Read line by line or row by row; never load a whole history store into memory.
12. **Listing is cheap.** `stat` plus a small head read, or one indexed query. No full parse.
13. **Never read credentials.** Database adapters select only the tables they need (OpenCode's
    database also holds account tokens; the fixture includes a decoy token to prove it is never read).
14. **Declare capabilities honestly.** `toolResults: false` tells consumers not to expect outcomes.
15. **Turns and usage only from the source.** Emit `turn.*` where the harness records boundaries and
    `usage.recorded` once per model call, converted to canonical semantics (input without cache
    reads, output including reasoning).

## Testing

1. Add a generator to `packages/testing/scripts/generate-fixtures.ts` that writes **sanitized**
   native fixtures for the shared scenario: a prompt, a file read, an edit, a failing and a passing
   `npm test`, a created file, a reply, plus one malformed record and one unknown record type.
   Never copy real history.
2. Register paths and IDs in `packages/testing/src/fixtures.ts` (`scenario`, `fixtureBridgeOptions`).
3. Run the shared suite and add goldens:

   ```ts
   adapterContract({ harness: "my-harness", layer, expectedSessions: [...], damagedSession: "..." })
   expectGolden(goldenPath, events)   // pnpm update-golden to rewrite
   ```

4. Add the scenario to `packages/platform-node/test/equivalence.test.ts`. It must produce the
   reference semantic projection, adjusted only by capabilities (e.g. no command outcomes without
   `toolResults`).
5. Run `pnpm audit:local` against real history: zero unreadable sessions, zero invariant
   violations, and no unexplained warnings.

## Compatibility matrix

Reflects what is implemented and tested, not what a harness could support. "Real data" means the
adapter was audited against real local history as well as fixtures.

| | Claude Code | Codex | OpenCode | pi | Gemini CLI | Cursor | Antigravity | ACP | oh-my-pi | Amp | Factory Droid | Copilot CLI | Qwen Code | Grok Build | Kimi Code | Crush | Goose |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Storage | JSONL | JSONL | SQLite | JSONL | JSON | JSONL | JSONL | JSON-RPC stream / JSONL recording | JSONL | JSON | JSONL | JSONL | JSONL | JSONL | JSONL | SQLite (per project) | SQLite (+ legacy JSONL) |
| Verified on real data | ✓ | ✓ | ✓ | ✓ | fixtures only | ✓ | fixtures only | fixtures + live stream test | fixtures only | fixtures only | fixtures only | fixtures only | fixtures only | fixtures only | fixtures only | fixtures only | fixtures only |
| Detect | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | recordings dir | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Subagents as linked sessions | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | – | ✓ | – (Task call and result only) | ✓ | ✓ (inline in the parent log; resolvable, not listed) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Relationships | resume | fork | – | fork | – | – | – | – | fork | fork, resume (handoff), related (mention) | fork | fork, child | fork, child | fork | fork, child | – | – |
| Messages / notices | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (chunks coalesced) | ✓ | ✓ | ✓ | ✓ (chunks coalesced) | ✓ | ✓ (chunks coalesced) | ✓ | ✓ | ✓ |
| Reasoning | exposed | summaries | exposed | exposed | summaries | – | – | exposed | exposed | exposed | exposed | exposed | exposed | exposed | exposed | exposed | exposed |
| Tool calls + kinds | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (no call IDs) | ✓ (no call IDs) | ✓ (native kinds) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (native ACP kinds) | ✓ | ✓ | ✓ |
| Tool results | ✓ | ✓ | ✓ | ✓ | ✓ | **not recorded** | paired by order (inferred) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Command exit codes | on failure | ✓ | ✓ | from trailer | ✓ | – | from output | from `rawOutput` | from details + trailer | ✓ | from output | ✓ | ✓ | from output | on failure (+ background tasks) | on failure (output trailer) | structured output / trailer |
| File read | known | inferred | known | known | known | inferred | inferred | known | known | known | known | known | known | known | known | known | known |
| File create vs change | ✓ | ✓ | ✓ | change only | ✓ | inferred | change only, inferred | ✓ | ✓ (`write` change only) | create inferred, `apply_patch` ✓ | ✓ (Create inferred) | ✓ | ✓ | ✓ (ACP diffs) | ✓ (Write create inferred) | ✓ (`write` create inferred) | ✓ (legacy editor inferred) |
| Plans | TodoWrite | update_plan | todowrite | – | write_todos | TodoWrite (merge, inferred) | – | ✓ | `todo` | todo_write | TodoWrite (`todo_state`) | update_todo | todo_write | ACP `plan` | TodoList | `todos` | – |
| Turns | ✓ | ✓ | ✓ | ✓ | end inferred | ✓ (end inferred from tool-free replies; measured) | end inferred | ✓ | ✓ | ✓ | ✓ (end from `agent_turn_outcome`) | ✓ (prompt → tool-free reply) | end inferred | ✓ (`turn_completed`) | ✓ | ✓ (finish parts) | end inferred |
| Token usage | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ | ✓ | – | output only (totals in metadata) | ✓ | – (per-run totals in metadata) | ✓ | – (session totals in metadata) | ✓ |
| User shell commands | ✓ (`!cmd`, no exit code) | ✓ | – | ✓ (`!cmd`, exit code) | – | – | – | – | ✓ (`!cmd`, Python, exit code) | ✓ (`$cmd`, exit code) | – | – | – | – | ✓ (`!cmd`, no exit code) | ✓ (`!cmd`, exit code) | – |
| Timestamps | ✓ | ✓ | ✓ | ✓ | ✓ | user turns only | ✓ | receive time | ✓ | prompts and replies only | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (seconds) | ✓ (seconds) |
| Live (also via daemon, shared tail) | `watch` (tail) | `watch` (tail) | `watch` (re-read) | `watch` (re-read) | `watch` (re-read) | `watch` (tail) | `watch` (tail) | `acpEvents`, `watch` (tail) | `watch` (re-read) | `watch` (re-read) | `watch` (re-read) | `watch` (tail) | `watch` (re-read) | `watch` (re-read) | `watch` (re-read) | `watch` (re-read) | `watch` (re-read) |
| Session end | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded |
