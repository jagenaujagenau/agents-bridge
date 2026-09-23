# Architecture

> Effect powers the runtime. Plain data powers the protocol.

## Packages and the dependency rule

```text
@agentbridge/schema                 protocol: Effect Schemas → types, codecs, JSON Schema, arbitraries
        ↑
@agentbridge/core                   Bridge service, HarnessRegistry, SessionStore, errors, emission pipeline,
        ↑                           HostEnvironment, VersionProbe, SqliteReader, FileHistoryAdapter,
        │                           record decoders (Effect platform only)
        │
 ┌──────┴──────────────────────────────────────────────────────────────┐
 adapter-claude-code  adapter-codex  adapter-opencode  adapter-pi         store-memory  store-sqlite
 adapter-gemini-cli   adapter-cursor adapter-antigravity adapter-acp
 └──────┬──────────────────────────────────────────────────────────────┘
        ↑
@agentbridge/platform-node          NodeBridge.layer(), NodeVersionProbe, NodeSqliteReader (node:sqlite)
        ↑
@agentbridge/daemon                 serveDaemon (Unix socket, HTTP + JSONL) and DaemonBridge (same Bridge API as a client)
        ↑
@agentbridge/cli                    reference consumer
examples/replay                     depends on core + schema only

@agentbridge/testing                contract suites, fixtures, invariants, semantic projection
```

- `schema` depends on nothing but `effect`.
- `core` never names a harness (an architectural test enforces it).
- Adapters depend on `FileSystem` / `Path` from Effect, never `node:fs`. Node is wired in
  `platform-node`.
- Consumers (`examples/replay`, the CLI) never import adapters.

## Data flow

```text
FileSystem.stream(path)
  → Stream.decodeText → Stream.splitLines                  core/sources.ts  (lossy UTF-8, no full read)
  → decodeLine: unknown JSON → provider schema             adapter/*Source.ts
  → Stream.mapAccum(normalizeLine)                          adapter/*Normalizer.ts (pure)
  → Stream<Emission>            Event | Warning | Metadata
        │
        ├─ sequenceEvents(sessionId)  → Stream<SessionEvent>     core/normalize.ts
        └─ loadSession(descriptor)    → { session, warnings, eventCount }
```

Adapters produce **emissions**, not finished events. Sequencing, warning summarisation and the
folding of session metadata are shared in core, so every adapter behaves the same way on those
points.

`RecordScope` (core) is what a normalizer uses to emit events for one native record: it assigns
stable IDs (spec §33), fills provenance, and lets the normalizer reserve IDs to link
`parentEventId` / `derivedFrom` before emitting.

Normalizer state lives in the `mapAccum` accumulator (open tool calls, staged
`exec_command_end` records, …). No module-level mutable state.

## Services and layers

| Service | Provided by |
|---|---|
| `Bridge` | `Bridge.layer` (needs `HarnessRegistry`, `SessionStore`, `FileSystem`, `Path`) |
| `HarnessRegistry` | `HarnessRegistry.layer([Effect.service(ClaudeCodeAdapter), …])` |
| each adapter (`ClaudeCodeAdapter`, `CodexAdapter`, `OpenCodeAdapter`, `PiAdapter`, `GeminiCliAdapter`, `CursorAdapter`, `AntigravityAdapter`, `AcpRecordingAdapter`) | `*.layer` (needs `HostEnvironment`, `VersionProbe`, `FileSystem`, `Path`; OpenCode also `SqliteReader`) |
| `HostEnvironment` | `layerConfig` (process environment via `Config`), `layerWithOverrides({...})`, or `layer({...})` for tests |
| `VersionProbe` | `NodeVersionProbe` (spawns `--version` with a timeout) or `VersionProbe.layerNoop` |
| `GitRepository` | `NodeGitRepository` (`git` binary, argument arrays, fsmonitor off); optional |
| `SqliteReader` | `NodeSqliteReader` (read-only `node:sqlite`, scoped per stream) |
| `SessionStore` | `MemorySessionStore.layer` or `SqliteSessionStore.layer(file)` (lazy `node:sqlite`) |

`NodeBridge.layer({ adapters?, probeVersions?, environment?, database? })` composes all of these from the same public layers.

Three adapter shapes share the pipeline:

- **File per session** (Claude Code, Codex, pi, Gemini CLI, Cursor, Antigravity, ACP recordings):
  walk roots → classify path → stat + head → descriptor; read streams lines through a provider decoder.
  All but Claude Code and Codex use `makeFileHistoryAdapter`.
- **Database** (OpenCode): one indexed query lists sessions; reading streams joined message/part rows,
  grouped per message with `Stream.groupAdjacentBy`.
- **Protocol stream** (ACP): `acpEvents` is a `Stream` transformer over whatever an ACP client
  observes, live or recorded. Bridge does not own the connection.

```ts
import { Bridge } from "@agentbridge/core"
import { NodeBridge } from "@agentbridge/platform-node"
import { Console, Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  const bridge = yield* Bridge
  yield* bridge.sessions.list().pipe(Stream.runForEach((s) => Console.log(s.id)))
  yield* bridge.sessions.events("codex:…").pipe(Stream.runForEach(handleEvent))
})

program.pipe(Effect.provide(NodeBridge.layer()), Effect.runPromise)
```

## Reading modes

- `events(id, { enrichers? })`: one pass over the source.
- `watch(id, { interval?, enrichers?, verifyGit?, redact? })`: existing events, then new ones. Adapters
  with `follows` are tailed from the last byte offset through the same normalizer; others are
  re-read when their file (or SQLite WAL) changes, emitting events past the last sequence.
- `export(id, dir, { enrichers? })` / `index(id, { force? })`: one pass that folds the session and writes
  events together. `index` skips sources whose fingerprint matches the stored one.

Enrichers (`core/enrich.ts`) are per-session stateful steps `(event) => events`, applied after
normalization and followed by resequencing, so they never see provider data.

## Deployment modes (spec §71)

```text
embedded:  app ──► Bridge (NodeBridge.layer) ──► adapters ──► history
daemon:    app ──► Bridge (DaemonBridge.layer) ──► ~/.bridge/daemon.sock ──► Bridge (embedded) ──► …
```

Both provide the same `Bridge` service. The daemon adds a shared tail per watched session and a single
process holding the SQLite index; clients stay thin. `bridge` picks the daemon automatically when one
is running (`BRIDGE_DAEMON=auto`).

## Errors

Expected failures are `Schema.TaggedError`s: `SessionNotFound`, `SessionReadError`,
`SessionParseError`, `AdapterUnavailable`, `CapabilityNotSupported`, `StoreError`, `ExportError`, …
(`BridgeError` is the union). Malformed or unknown provider records are **not** errors; they become
import warnings and the session keeps loading. Detection never fails: problems with individual
signals become `notes`.

## Observability

Spans: `bridge.detect-harnesses`, `bridge.detect`, `bridge.list-sessions`, `bridge.load-session`,
`bridge.normalize-session`, `bridge.export-session`, `bridge.store-session`. Attributes carry harness,
session ID and counts, never prompt or file content.

## Not built yet (by design)

Live ACP traffic is consumed directly through `acpEvents`; Bridge does not manage agent processes.
