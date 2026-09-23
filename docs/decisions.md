# Decisions and Spec Adjustments

Where the implementation departs from `BRIDGE_EFFECT_V4_SPEC.md` (draft v0.2), and why. Most changes
were forced by real Claude Code and Codex history (see `docs/research/reference-findings.md`) rather
than added speculatively.

Pinned runtime: `effect@4.0.0-rc.115`, `@effect/platform-node@4.0.0-rc.115`.

## Protocol

| # | Spec | Implemented | Evidence / reason |
|---|---|---|---|
| 1 | §55–56 `_tag` internally, `type` on the wire via a transformation | `type` everywhere; events are `Schema.Struct` with `Schema.tag` | No transformation layer that can drift. The JSON Schema test asserts no `_tag` leaks. |
| 2 | §11, §13 `Schema.Class` / `TaggedClass` | `Schema.Struct` | Protocol values stay plain objects; normalizers build them as literals. |
| 3 | §13 `tool.started {name, input}` | adds `kind: ToolKind` (ACP-aligned) | Without it a tool view must know that `Bash` and `exec_command` are the same (§91 leak). |
| 4 | — | adds `harness.notice {kind, content}` | Both harnesses put large injected payloads in the user role (Claude: 84 locally, Codex: 33). As `user.message` they look like fake prompts; dropped, hook output is lost. |
| 5 | — | adds `context.compacted` | Claude `isCompactSummary` / `compact_boundary`, Codex `compacted`. Otherwise the summary appears as a user message. |
| 6 | §13 `command.completed {exitCode?}` | adds required `outcome` | Claude records no exit code on success. Consumers need "did it pass" without interpreting providers. `exitCode` is never defaulted. |
| 7 | §13 `file.created` / `file.deleted` "additional variants" | implemented, plus `file.changed.previousPath` | Codex patches add, delete and move files. |
| 8 | §66 `session.completed` required | not emitted for history; `Session.status = "unknown"` | Neither format records a session end. `task_complete` is per turn. |
| 9 | §79 relationships model | `Session.relationships?: SessionRelationship[]` | Real records: Claude `continued-in` (resume), Codex `forked_from_id` (fork). |
| 10 | §11 `Session` | adds `agentLabel`, `updatedAt` | Needed to render subagent trees and recency without loading events. |
| 11 | §27 `SessionDescriptor` (unspecified) | `{id, harness, nativeId, sourcePath, sizeBytes, projectPath?, parentSessionId?, agentLabel?, startedAt?, updatedAt?}` | Cheap to build from `stat` plus a head read. |
| 12 | §26 `DetectionResult` | adds `name`, `notes` | Per-signal problems without failing detection. |
| 13 | §8 `SourceReference` | adds `recordIndex` | Codex has no native IDs; the record index is its provenance and ID anchor. |
| 14 | §33 hash unspecified | SHA-256 over `U+001F`-joined parts, truncated to 128 bits, pure TypeScript | Reproducible in any language; tested against `node:crypto`. |
| 15 | §73 unknown event handling | `decodeEventLineTolerant` | Unknown `type` → skipped; malformed known type → error. |

## Runtime

| # | Spec | Implemented | Reason |
|---|---|---|---|
| 16 | §17 adapter returns `loadSession` + `events` | adapter returns one `read: Stream<Emission>`; core derives `events` (sequenced) and `get` (metadata + warnings) | Sequencing, warning summarisation and metadata folding are identical for every adapter, so they live in core. Warnings (§35, §75) travel in the same stream as events without a second parse. |
| 17 | §18 registry via `Context.Service` `effect:` option | `HarnessRegistry.layer([Effect.service(Adapter)…])` | The spec allowed a simpler Layer-supplied collection. |
| 18 | §19 `watch` | fails with `CapabilityNotSupported` | No live adapter yet (M6). |
| 19 | §26 version probing | `VersionProbe` service; Node implementation spawns `--version` with a 5s timeout | Keeps adapters testable without spawning processes. |
| 20 | §38 SQLite | not built | Spec §93: do not begin with SQLite. `SessionStore` contract suite is ready for it. |
| 21 | §85 Biome | not added | Kept tooling minimal: `tsc` (TS 7) and Vitest with `@effect/vitest`. |

## Normalization rules adopted

- **One source per fact (Codex).** Messages and tool calls come from `response_item`; exit codes,
  durations and parsed reads from `exec_command_end`; patch results from `patch_apply_end`. Both
  orders are handled: an end record arriving before the output is staged; an output arriving while a
  process is still running leaves the command pending until its end record.
- **Reads hidden in shell commands.** Codex reads files via `sed`/`cat` through `exec_command`; its own
  command parser labels them. Bridge emits `file.read` with `certainty: "inferred"` and
  `parentEventId` pointing to the `command.started`. The equivalence projection treats a command whose
  only effect was a read as that read, using `parentEventId` rather than any provider knowledge.
- **Client wrappers (Codex).** `# Context from my IDE setup:` / `# In app browser:` sections followed by
  `## My request for Codex:` become a `user.message` holding only the request.
- **Slash commands and `!` input (Claude).** `<command-name>` markup becomes `/name args`;
  `<bash-input>` becomes `!cmd`.
- **Redacted reasoning.** Empty Claude `thinking` blocks and empty Codex summaries emit nothing.

## Verification

- v0.2: 213 tests. `pnpm audit:local` normalizes 607 real sessions (Claude Code 54, Codex 21,
  OpenCode 450, pi 22, Cursor 60; about 140k events) with zero unreadable sessions, zero invariant
  violations and zero warnings, in about 9s.
- v0.1: 104 tests: schema round-trips and property tests, store contract, adapter contracts over sanitized
  fixtures, golden files, cross-adapter semantic equivalence, one Replay consumer for both harnesses,
  architectural tests (no provider names in consumers or core, no adapter dependencies).
- `pnpm audit:local` on the development machine: 75 real sessions (54 Claude Code, 21 Codex,
  ~26k events) normalize with zero unreadable sessions, zero invariant violations and zero warnings, in
  about 1.5s.

## Adding the remaining harnesses (v0.2)

Evidence from OpenCode (450 real sessions), pi (22), Cursor (60) and the Gemini CLI, Antigravity and
ACP formats forced these model changes. Each was needed by at least one real format and would
otherwise have required a consumer to branch on the provider.

| # | Change | Evidence |
|---|---|---|
| 22 | `HarnessCapabilities.toolResults` / `SessionCapabilities.toolResults` | Cursor transcripts record tool calls but never their results. Consumers need to know that a missing `tool.completed` means "not recorded", not "still running". The equivalence test adjusts its expectation by this capability, never by harness ID. |
| 23 | `SessionDescriptor.sizeBytes` optional | OpenCode stores every session in one SQLite database; a session has no file size. |
| 24 | `harness.notice` kind `error` | pi `stopReason: "error"`, OpenCode `APIError`, Cursor `turn_ended` with `status: "error"`, Gemini CLI `error` messages, ACP `refusal`. |
| 25 | `plan.updated {entries}` | ACP streams `plan` updates natively (spec §45). Historical todo tools (TodoWrite, update_plan, write_todos) are mapped to `kind: "think"` tool calls for now. |
| 26 | Tool call IDs may be derived | Cursor and Antigravity tool calls carry no IDs. The adapter uses the call's own stable event ID as `toolCallId`, so IDs stay deterministic. |
| 27 | `certainty: "inferred"` on tool completions and file effects | Cursor never records outcomes, so its file effects are what the call requested. Antigravity pairs outputs with calls by order, not by ID. Both are marked inferred rather than dropped or overclaimed. |
| 28 | Timestamps normalized in `RecordScope` | Harnesses write RFC 3339, ISO without milliseconds, epoch milliseconds (OpenCode) and localized strings (Cursor `<timestamp>Saturday, June 14, 2026, 3:42 PM (UTC+2)`). Valid RFC 3339 is kept, parseable dates become UTC, the rest are dropped. |
| 29 | Session `startedAt` prefers the source head over the first event | Antigravity replays earlier turns in `CONVERSATION_HISTORY` steps that are skipped as events but still mark the start. |

Runtime additions:

| # | Change | Reason |
|---|---|---|
| 30 | `HostEnvironment` service | Every adapter reads `HOME`, `PATH` and one override variable. One service, read through `Config`, replaces per-adapter config services (including the earlier `ClaudeCodeConfig` / `CodexConfig`). Tests supply a static environment. |
| 31 | `makeFileHistoryAdapter` and `detectHarness` | Five of eight adapters keep one file per session. Walking, stat-ing, head reads, dedupe by priority (Antigravity keeps `transcript.jsonl` and `transcript_full.jsonl`) and resolution are shared. |
| 32 | `SqliteReader` service over `node:sqlite` | OpenCode. Read-only, scoped to the stream. `@effect/sql-sqlite-node` was not used because its native driver adds a build step; the service boundary keeps that choice swappable (spec §39). |
| 33 | ACP as a transformer, not a process manager | GOAL.md: do not rebuild execution that belongs to ACP. `acpEvents` normalizes whatever an ACP client observes (live or recorded); `AcpRecordingAdapter` exposes recordings through the registry. |

Adapter-specific interpretation choices:

- **OpenCode** is read from the `session`, `message` and `part` tables only. A tool part holds both
  call and outcome; exit codes come from `metadata.exit` (sometimes `null` → outcome `unknown`).
  `write` with `metadata.exists: false` is `file.created`. Synthetic user text is a notice.
- **pi** entries form a tree (`id`/`parentId`, branches via `/tree`); events follow file order and
  include abandoned branches. Bash exit codes come from the `Command exited with code N` trailer.
  `write` cannot tell create from overwrite, so it is `file.changed`.
- **Gemini CLI** chat IDs come from the file name (`session-<time>-<id>.json`); the project is
  resolved from `.project_root`, `projects.json` or sha256 of `trustedFolders.json` entries.
  Implemented from the reference parser and Gemini CLI's recording format; no local history was
  available to audit.
- **Cursor** project directories encode `/` and `.` as `-`; the path is rebuilt by probing which
  directories exist (58/60 real sessions resolve; the rest point at deleted temp directories).
- **Antigravity** is implemented from the reference parser's documented shapes; its authors mark
  edit-tool argument names as unverified, and no local history was available.

## Review fixes (v0.2.1)

A review of the code against these docs found and fixed:

| # | Fix | Why |
|---|---|---|
| 34 | `tool.updated {toolCallId, name?, kind?, input?}` | ACP sends tool metadata incrementally (`tool_call_update` may change title, kind or input after the call starts). Omitted fields are unchanged; `input: null` clears. |
| 35 | Export and index read the session once | Both previously read the source twice (once for metadata, once for events), so a session growing between reads produced a bundle whose manifest disagreed with its events. Exports are staged in a temp directory and renamed into place; a non-empty destination is refused. |
| 36 | ACP inline images and late inputs | Standard base64 `image` blocks became `data:` URIs instead of being dropped. `rawInput` arriving after `tool_call` is kept. Tool state no longer grows quadratically. |
| 37 | Gemini nested function results, timestamps, warning aggregation | Nested `functionResponse` outputs are read; invalid timestamps are dropped; warnings are summarised like every other adapter. |
| 38 | Discovery cached for 5 s; `projectPath` filters by directory membership | Listing then resolving no longer walks the history tree twice. `--project /a/b` no longer matches `/a/bc`. |
| 39 | Calendar-aware `Timestamp` validation | `2026-02-30T…` was accepted by the pattern alone. |

## Remaining open items (v0.3)

All six items left after v0.2 are now implemented:

| # | Change | Evidence / reason |
|---|---|---|
| 40 | Plans from todo tools, tolerant of real statuses | TodoWrite (Claude, Cursor), `update_plan` (Codex), `todowrite` (OpenCode) and `write_todos` (Gemini) emit `plan.updated`. Real OpenCode data has `cancelled` and `blocked` statuses and lists stored as JSON strings; Cursor sends `merge: true` status-only updates. `cancelled` entries leave the plan, `blocked` is `pending`, a missing status is `pending`, entries without text are dropped. This removed the last 14 warnings from the local audit. |
| 41 | pi active branch only | pi entries form a tree and `/tree` leaves abandoned branches in the file. A first pass reads `id`/`parentId` from every line (ignored entry types included, since they sit inside the chain), then only the path from the last entry to the root is normalized. No local pi file branches today; covered by a fixture. |
| 42 | `bridge watch` for every history adapter | Polls the source file (and its SQLite `-wal`) and re-reads it when size or mtime change, emitting events past the last sequence seen. Correct because normalization is deterministic and sources are append-only. Ceiling: a full re-read per change, and an event whose content changes after emission (a buffered ACP chunk) is not re-sent. Upgrade path: byte-offset tailing. |
| 43 | `turn.started` / `turn.completed {outcome}` | Emitted only where the source records turns: Claude (`promptId` + `system/turn_duration`, interruptions from `[Request interrupted…]`), Codex (`task_started` / `task_complete` / `turn_aborted`), ACP (prompt request → response `stopReason`). A new prompt closes an unfinished turn as `inferred` / `unknown`. Other harnesses emit none rather than fabricate. |
| 44 | `usage.recorded` per model call | Claude `message.usage` (one API message spans several lines, so usage is emitted once, after its last line), Codex `token_count.last_token_usage` (repeated counts skipped by total), OpenCode `step-finish`, pi message `usage`, Gemini `tokens`. Canonical semantics: `inputTokens` excludes cache reads, `outputTokens` includes reasoning, so OpenAI/Gemini counts are converted. OpenCode's reasoning split is taken as recorded. |
| 45 | User-run shell commands | Claude `<bash-input>` + `<bash-stdout>` and Codex `exec_command_end` without a tool call become `command.started` / `command.completed` with no tool parent, not user messages. Claude records no exit status for them (`outcome: unknown`). |
| 46 | `@agentbridge/store-sqlite` | Spec §38 schema on `node:sqlite`: canonical JSON plus indexed columns, keyset-paginated event reads, WAL mode. Opened lazily, so CLI commands that never touch the store never create a file. Passes the same contract suite as the memory store. |
| 47 | Incremental index | `SessionStore` stores a source fingerprint (path, size, mtime / row update time). `bridge index` skips unchanged sessions: 636 real sessions index in about 4 s, an unchanged re-run in about 1.3 s. |
| 48 | Enrichers: `gitEnricher`, `redactionEnricher` | Opt-in (`--git`, `--redact` on `events`, `watch`, `export`). Git derives `git.commit {commit?, branch?, message?}` (`inferred`) from non-failed `git commit` commands, reading git's own `[branch hash] message` line when recorded. Redaction masks private keys, GitHub/AWS/Anthropic/OpenAI/Slack/Google keys, bearer tokens and `*_KEY=`-style assignments in content fields only. It is a heuristic and cannot guarantee that nothing sensitive remains. |

## Still open

- **Byte-offset tailing** for `watch` on large sessions.
- **Turns** for OpenCode, pi, Gemini CLI, Cursor and Antigravity: consumers derive them from
  `user.message` until a source records boundaries.
- **Git certainty upgrade** (spec §42): verify derived commits against the repository.
- **Redacting session metadata** (titles come from prompts); redaction covers events only.
