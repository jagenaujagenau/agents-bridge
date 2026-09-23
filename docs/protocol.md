# Bridge Wire Protocol — v1

Bridge's public artifact is plain data:

```text
Session  +  ordered SessionEvent stream  +  portable JSON representation
```

No Effect runtime is needed to read it. JSON Schemas (draft 2020-12) generated from the
Effect Schemas live in [`schemas/v1/`](../schemas/v1):

| File | Describes |
|---|---|
| `session.schema.json` | `Session` |
| `event.schema.json` | one `SessionEvent` (one JSONL line) |
| `manifest.schema.json` | export `manifest.json` |
| `import-warning.schema.json` | `ImportWarning` |

Regenerate with `pnpm schemas`; a test fails if the committed files are stale.

Protocol version (`1`) is independent of package versions.

---

## Conventions

- **Discriminator**: every event and content block has a `type` field. There is no `_tag` on the wire,
  and none in memory either: the schemas use `type` directly, so there is no transformation to drift.
- **Timestamps**: RFC 3339 strings (`2026-09-13T17:31:42.391Z`).
- **Optional fields are omitted**, never `null`.
- **Paths are preserved as the source observed them** (absolute or relative). Consumers that want
  project-relative paths resolve them against `Session.projectPath`.

## Session

```json
{
  "id": "codex:22222222-2222-4222-8222-222222222222",
  "harness": { "id": "codex", "name": "Codex", "version": "0.130.0" },
  "status": "unknown",
  "title": "Add README usage section",
  "projectPath": "/work/demo",
  "parentSessionId": "codex:…",
  "agentLabel": "explorer",
  "startedAt": "2026-09-01T10:00:00.000Z",
  "updatedAt": "2026-09-01T10:00:13.000Z",
  "relationships": [{ "type": "fork", "from": "codex:child", "to": "codex:origin" }],
  "capabilities": { "history": true, "live": false, "resume": false, "toolCalls": true, "toolResults": true,
                    "reasoning": true, "tokenUsage": false, "fileEvents": true, "commandEvents": true },
  "metadata": { "model": "gpt-5.5", "gitBranch": "main" }
}
```

### Session IDs

`<harnessId>:<nativeId>`. Subagent sessions whose source has no ID of their own use
`<harnessId>:<parentNativeId>/<suffix>`; ACP sessions are `acp:<agent>/<acp session id>`.
IDs are deterministic across imports.

Harness IDs: `claude-code`, `codex`, `opencode`, `pi`, `gemini-cli`, `cursor`, `antigravity`, `acp`.

### Capabilities

`capabilities` says what the source records, so consumers decide by capability rather than by
harness: `history`, `live`, `resume`, `toolCalls`, `toolResults`, `reasoning`, `tokenUsage`,
`fileEvents`, `commandEvents`. With `toolResults: false` (Cursor), tool calls, commands and file
effects have no completions, and file effects are `inferred`.

### Session status

None of the supported history formats records a session end. Imported history therefore has
`status: "unknown"` and **no `session.completed` event**. Bridge never fabricates an end; a future
adapter may emit `session.completed` with `certainty: "inferred"` if it has real evidence.

### Relationships

`parentSessionId` covers spawned subagents. `relationships` covers other links, read as
"`from` has relationship `type` to `to`":

| type | meaning | observed in |
|---|---|---|
| `fork` | `from` was forked from `to` | Codex `session_meta.forked_from_id` |
| `resume` | `from` continues `to` | Claude Code `continued-in` records |

pi forks (`session.parentSession`) are also `fork`.

## Events

Every event has the base fields:

| field | type | notes |
|---|---|---|
| `type` | string | see below |
| `id` | string | stable, see [Stable event IDs](#stable-event-ids) |
| `sessionId` | string | |
| `sequence` | int ≥ 0 | 0, 1, 2, … in stream order |
| `timestamp` | RFC 3339? | the source record's time, when recorded |
| `durationMs` | number? | |
| `parentEventId` | string? | structural parent (e.g. the `tool.started` of a `command.completed`) |
| `derivedFrom` | string[]? | events this one was derived from |
| `certainty` | `known` \| `inferred` \| `unknown` | how authoritative the event is |
| `source` | `{provider, format, path?, recordIndex?, nativeEventId?, version?}` | provenance, never raw payloads |

| type | extra fields | meaning |
|---|---|---|
| `session.started` | — | first event of a session |
| `session.completed` | — | only with evidence of an end |
| `session.failed` | `message?` | |
| `user.message` | `content` | a prompt written by the session's principal (a human, or the parent agent for subagents) |
| `agent.message` | `content` | |
| `agent.reasoning` | `content`, `representation: summary \| provider_exposed` | only reasoning the provider exposed |
| `harness.notice` | `kind`, `content` | text the harness injected or reported: `injected_context`, `command_output`, `task_notification`, `hook`, `interruption`, `error`, `other` |
| `context.compacted` | `summary?` | earlier context was replaced by a summary |
| `turn.started` | `turnId` | a prompt-to-response cycle began; only where the source records turns |
| `turn.completed` | `turnId`, `outcome: completed \| interrupted \| failed \| unknown` | `durationMs` when recorded |
| `usage.recorded` | `model?`, `inputTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `outputTokens?`, `reasoningTokens?` | tokens of one model call (a delta: sum for totals). Total input = input + cacheRead + cacheWrite; `outputTokens` includes reasoning |
| `plan.updated` | `entries: [{content, status: pending \| in_progress \| completed, priority?}]` | the agent's current plan, replacing earlier ones |
| `tool.started` | `toolCallId`, `name`, `kind`, `input?` | `kind` is ACP-aligned: `read edit delete move search execute think fetch other`. When the source has no call IDs, `toolCallId` is the event's own ID |
| `tool.updated` | `toolCallId`, `name?`, `kind?`, `input?` | metadata that arrived after the call started; omitted fields are unchanged |
| `tool.completed` | `toolCallId`, `output?` | |
| `tool.failed` | `toolCallId`, `message` | |
| `command.started` | `commandId`, `command`, `cwd?`, `shell?` | a shell command: derived from a tool call (`parentEventId` → `tool.started`), or run by the user directly (no parent) |
| `command.completed` | `commandId`, `outcome`, `exitCode?`, `stdout?`, `stderr?` | `outcome: succeeded \| failed \| interrupted \| unknown` is always present; `exitCode` is omitted when the source does not record it, never defaulted to `0` |
| `file.read` | `path` | |
| `file.created` | `path`, `diff?`, `language?` | emitted only after the tool result proves success |
| `file.changed` | `path`, `previousPath?`, `diff?`, … | idem |
| `file.deleted` | `path` | idem |
| `git.commit` | `commit?`, `branch?`, `message?` | only from the opt-in git enricher; `inferred`, or `known` once verified against the session's repository |
| `custom.<ns>.<event>` | `payload` | provider extension; safe to ignore |

`content` is an array of blocks: `{type:"text",text}`, `{type:"code",code,language?}`,
`{type:"file",path}`, `{type:"image",uri,mimeType?}`.

### Generic and semantic events

One tool call can produce both generic and semantic events, linked explicitly:

```text
tool.started (kind: execute)          ← generic tool inspector
 ├─ command.started   parent → tool.started
tool.completed / tool.failed
 └─ command.completed parent → tool.started, derivedFrom → [tool.started, tool result]
     └─ file.read     (inferred) parent → command.started   ← when the command only read a file
```

### Ordering

`sequence` follows provider record order, never wall-clock time. Events derived from one native
record are placed next to each other deterministically. Re-importing an unchanged source yields
identical sequences and IDs.

### Stable event IDs

```text
id = "evt_" + hex(SHA-256(UTF-8(join(parts, U+001F))))[0..32]

native ID available:  parts = [harness, sessionId, "native", nativeEventId, type, derivationIndex]
otherwise:            parts = [harness, sessionId, "record", recordIndex,   type, derivationIndex]
```

`derivationIndex` counts events of the same `type` produced from one native record.
Claude Code records carry a per-line `uuid`, used as the native ID. Codex rollouts have no native
event IDs and always use the record index: stable because rollouts are append-only, broken if a
rollout is rewritten.

## Enrichers

Enrichers are opt-in transformations applied when reading or exporting (`--git`, `--redact`).
They run on canonical events only, may add derived events (`git.commit`, with `derivedFrom` and a
stable ID anchored on the source event), and renumber `sequence` so it stays contiguous. An
enriched stream is therefore a different stream: IDs of original events are unchanged, sequences
may shift. Redaction replaces likely secrets in content fields with `[REDACTED:<kind>]`; identity,
ordering and provenance fields are never touched. With `redact`, the session's title, agent label
and metadata are masked the same way.

## Unknown events (forward compatibility)

Consumers must tolerate event types they do not know. Read JSONL line by line and skip lines whose
`type` is unknown. `decodeEventLineTolerant` in `@agentbridge/schema` does exactly this; a line with
a known `type` but invalid fields is still an error.

## Import warnings

A partially readable session still loads. Problems are summarised once per kind:

```json
{ "code": "malformed_json", "message": "Skipped lines that are not valid JSON", "count": 3,
  "source": { "provider": "claude-code", "format": "claude-code-jsonl", "path": "…", "recordIndex": 8 } }
```

Codes in use: `malformed_json`, `malformed_record`, `unknown_record_type`, `orphan_tool_result`.

## Session descriptors

`bridge sessions --json` returns descriptors: `{id, harness, nativeId, sourcePath, sizeBytes?,
projectPath?, parentSessionId?, agentLabel?, startedAt?, updatedAt?}`. `sizeBytes` is absent when
sessions share a database (OpenCode).

## ACP

`@agentbridge/adapter-acp` maps ACP v1 traffic to the same events:

| ACP | Bridge |
|---|---|
| `session/prompt` request, `user_message_chunk` | `user.message` |
| `agent_message_chunk` (coalesced) | `agent.message` |
| `agent_thought_chunk` (coalesced) | `agent.reasoning` (`provider_exposed`) |
| `tool_call` / `tool_call_update` | `tool.started`, `tool.completed` / `tool.failed` |
| `kind: execute` with `rawInput.command` | `command.started` / `command.completed` (exit code from `rawOutput`) |
| `diff` content | `file.created` (`oldText: null`) / `file.changed` |
| `kind: read` / `delete` locations | `file.read` / `file.deleted` |
| `plan` | `plan.updated` |
| `session_info_update.title` | `Session.title` |
| prompt response `stopReason: cancelled` / `refusal` | `harness.notice` `interruption` / `error` |

Recordings are JSONL, one message per line, either bare JSON-RPC or
`{"receivedAt": "<RFC 3339>", "message": <JSON-RPC>}`.

## Daemon API

`bridge daemon start` serves the same model over a Unix socket (`$BRIDGE_SOCKET`, default
`~/.bridge/daemon.sock`, owner-only). Plain HTTP; the host name is ignored.

| Method | Path | Query / body | Response |
|---|---|---|---|
| GET | `/v1/health` | | `{protocol, pid, startedAt, watches}` |
| GET | `/v1/harnesses` | | `[{id, name, capabilities}]` |
| GET | `/v1/harnesses/detect` | | `[DetectionResult]` |
| GET | `/v1/sessions` | `harness`, `project`, `since`, `refresh=1` | JSONL of `SessionDescriptor` |
| GET | `/v1/session/describe` | `id` | `SessionDescriptor` |
| GET | `/v1/session` | `id`, `redact=1` | `{session, warnings, eventCount}` |
| GET | `/v1/session/events` | `id`, `git=1`, `verifyGit=1`, `redact=1` | JSONL of `SessionEvent` |
| GET | `/v1/session/watch` | as events, plus `interval` (ms) | JSONL, open until the client disconnects |
| POST | `/v1/session/export` | `{id, destination (absolute), git?, verifyGit?, redact?}` | `{directory, manifest}` |
| POST | `/v1/session/index` | `{id, force?}` | `{session, warnings, eventCount, skipped}` |
| POST | `/v1/shutdown` | | `{stopping: true}` |

Errors are `{"error": {"_tag": "SessionNotFound", …}}` with status 404 (not found), 400 (bad
request) or 500. A failure in the middle of a JSONL stream arrives as a last line of the same shape.

## Export bundle

`bridge export <id> --out <dir>` writes:

```text
<dir>/manifest.json   {"format":"bridge-session","version":1,"sessionId":…,"harness":…,"eventCount":…,"warningCount":…}
<dir>/session.json    Session
<dir>/events.jsonl    one SessionEvent per line, in sequence order
```
