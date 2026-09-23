# Bridge

One typed model for coding-agent sessions. Bridge reads history from eight sources and produces
the same canonical `Session` + ordered `SessionEvent` stream, so applications never need to know
which harness produced a session.

```text
Claude Code  JSONL ────┐
Codex        rollouts ─┤
OpenCode     SQLite ───┤
pi           JSONL ────┤
Gemini CLI   JSON ─────┼─> identical useful Bridge primitives
Cursor       JSONL ────┤
Antigravity  JSONL ────┤
ACP          live / recorded JSON-RPC ─┘
```

Built with Effect V4 (`4.0.0-rc.115`) for Schema, Stream, Layer and services. The wire format is
plain JSON / JSONL with published JSON Schemas, so reading it needs no Effect.

## Quick start

```bash
pnpm install
pnpm check                 # typecheck + tests

pnpm bridge doctor         # what is installed, where history lives
pnpm bridge harnesses
pnpm bridge sessions --harness codex
pnpm bridge show <session-id>
pnpm bridge events <session-id>          # human-readable
pnpm bridge events <session-id> --jsonl  # canonical JSONL
pnpm bridge events <session-id> --git --redact   # derive + verify commits, mask secrets
pnpm bridge watch <session-id>           # existing events, then new ones as the session grows
pnpm bridge index                        # import everything into the SQLite index ($BRIDGE_DB)
pnpm bridge daemon start --detach        # serve Bridge on ~/.bridge/daemon.sock; other commands use it automatically
pnpm bridge daemon status | stop
pnpm bridge export <session-id> --out ./out

pnpm audit:local           # normalize every local session; report counts, warnings, invariant violations
```

Each harness's history location can be overridden: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`OPENCODE_DATA_DIR`, `PI_CODING_AGENT_DIR`, `GEMINI_CLI_HOME`, `CURSOR_CONFIG_DIR`,
`ANTIGRAVITY_HOME`, `BRIDGE_ACP_RECORDINGS`.

## Using it from code

```ts
import { Bridge } from "@agentbridge/core"
import { NodeBridge } from "@agentbridge/platform-node"
import { Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  const bridge = yield* Bridge
  const { session, warnings } = yield* bridge.sessions.get("codex:019e469b-…")
  yield* bridge.sessions.events(session.id).pipe(
    Stream.runForEach((event) => {
      switch (event.type) {
        case "user.message":      /* conversation */ break
        case "command.completed": /* terminal: event.outcome, event.exitCode? */ break
        case "file.changed":      /* diff view: event.path, event.diff? */ break
      }
      return Effect.void
    })
  )
})

program.pipe(Effect.provide(NodeBridge.layer()), Effect.runPromise)
```

`examples/replay` is a small Replay consumer that renders sessions from every harness with no
provider branches. An architectural test enforces that.

Live ACP traffic uses the same event type:

```ts
import { acpEvents } from "@agentbridge/adapter-acp"

messagesFromYourAcpClient.pipe(               // Stream<unknown> of JSON-RPC messages
  acpEvents({ agent: "gemini", sessionId }),  // Stream<SessionEvent>
  Stream.runForEach(renderEvent)
)
```

## Packages

| Package | Role |
|---|---|
| `@agentbridge/schema` | Protocol: IDs, `Session`, `SessionEvent`, codecs, stable IDs, JSON Schema generation |
| `@agentbridge/core` | `Bridge`, `HarnessRegistry`, `SessionStore`, errors, shared normalization pipeline |
| `@agentbridge/adapter-claude-code` | `~/.claude/projects/**.jsonl` |
| `@agentbridge/adapter-codex` | `~/.codex/sessions/**/rollout-*.jsonl` |
| `@agentbridge/adapter-opencode` | `~/.local/share/opencode/opencode.db` (read-only SQLite) |
| `@agentbridge/adapter-pi` | `~/.pi/agent/sessions/**.jsonl` |
| `@agentbridge/adapter-gemini-cli` | `~/.gemini/tmp/*/chats/session-*.json` |
| `@agentbridge/adapter-cursor` | `~/.cursor/projects/*/agent-transcripts/**.jsonl` |
| `@agentbridge/adapter-antigravity` | `~/.gemini/antigravity[-cli]/brain/*/.system_generated/logs/transcript*.jsonl` |
| `@agentbridge/adapter-acp` | ACP v1 streams (`acpEvents`) and recordings |
| `@agentbridge/store-memory` | In-memory `SessionStore` |
| `@agentbridge/store-sqlite` | Persistent `SessionStore` on `node:sqlite`, incremental by source fingerprint |
| `@agentbridge/platform-node` | `NodeBridge.layer()`, version probing, `node:sqlite` reader, local history audit |
| `@agentbridge/testing` | Fixtures, adapter/store contract suites, invariants, semantic projection, goldens |
| `@agentbridge/daemon` | Background service on a Unix socket, and `DaemonBridge`: the same `Bridge` API as a client |
| `@agentbridge/cli` | `bridge` reference CLI |

## Docs

- [Protocol](docs/protocol.md): wire format, events, IDs, ordering, export bundle
- [Architecture](docs/architecture.md): packages, data flow, services and layers
- [Adapter authoring](docs/adapter-authoring.md): rules, testing, compatibility matrix
- [Decisions](docs/decisions.md): where and why the implementation departs from the spec
- [Reference findings](docs/research/reference-findings.md): what real history formats look like
- JSON Schemas: [`schemas/v1/`](schemas/v1)

## Status

v0.1 scope (spec §94) is met, and v0.2 extends it to every harness in the reference set:

- `bridge harnesses` detects all eight sources.
- `bridge sessions` lists them through one registry.
- `bridge events --jsonl` emits valid canonical events.
- The same §63 scenario, recorded natively for each harness, produces the same semantic event sequence
  (adjusted only by declared capabilities).
- `pnpm audit:local` on the development machine normalizes 607 real sessions from five harnesses with
  zero invariant violations.

Gemini CLI and Antigravity are verified against fixtures built from their documented formats only;
no local history was available. See [docs/decisions.md](docs/decisions.md).

v0.3 adds turns, token usage, user shell commands, plans from todo tools, `bridge watch` for every
harness, the SQLite index and the git / redaction enrichers.

v0.4 tails growing sessions from the last byte offset, emits turns for every harness, verifies
derived commits against the repository and redacts session metadata.

v0.5 adds the background daemon: one process serves many clients over an owner-only Unix socket, with
one shared tail per watched session. Switching an application to it is a one-layer change.
