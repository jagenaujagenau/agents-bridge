# Bridge — Effect V4 Implementation Spec

## Status

Draft v0.2

## Purpose

This document turns the Bridge architecture into an implementation-ready specification using **Effect V4** and the Effect ecosystem.

Bridge is the canonical compatibility and session-data layer for coding-agent harnesses.

It should let applications consume historical and live coding-agent sessions through one typed model without needing to understand whether the source was Claude Code, Codex, OpenCode, Gemini CLI, Cursor, ACP, or another harness.

The core implementation principle is:

> **Effect powers the runtime. Plain data powers the protocol.**

Internally, Bridge should use:

- `Effect`
- `Stream`
- `Layer`
- `Context.Service`
- `Schema`
- Effect Platform
- Effect SQL where useful
- typed domain errors
- structured concurrency

Externally, Bridge should expose a runtime-neutral JSON / JSONL representation so that consumers do not need to use Effect.

---

# 1. Architecture

```text
                        BRIDGE

                    Plain Protocol
               JSON / JSONL / JSON Schema
                         ▲
                         │
                    Effect Schema
                         ▲
                         │
                 Canonical Domain
                         ▲
                         │
             ┌───────────┴───────────┐
             │                       │
       Historical Adapters       Live Adapters
             │                       │
       Claude / Codex /          ACP / native
       OpenCode / ...            event streams
             │                       │
             └───────────┬───────────┘
                         │
                      Stream
                         │
               normalization pipeline
                         │
             ┌───────────┼────────────┐
             ▼           ▼            ▼
           Deck        Replay       Lessons
```

Bridge should be usable in-process.

A daemon may be added later, but the daemon must be an alternative backend for the same domain API rather than becoming the core abstraction.

---

# 2. Why Effect

Bridge is a good fit for Effect because its primary concerns are:

- parsing untrusted external formats
- representing failures explicitly
- streaming historical and live events
- working with filesystem and processes
- managing runtime dependencies
- running concurrent adapters
- preserving cancellation semantics
- swapping implementations in tests
- incremental decoding
- resource-safe watchers
- retry / timeout policies
- optional persistence

The implementation should make these concerns explicit in the type system.

---

# 3. Design Rules

## 3.1 Effect internally, plain data externally

A consumer using Bridge's wire format should never need Effect.

Good:

```json
{
  "type": "file.changed",
  "sessionId": "ses_...",
  "sequence": 42,
  "path": "src/index.ts"
}
```

Avoid serializing runtime concepts such as:

```text
Effect
Layer
Fiber
Cause
Exit
Context
```

The canonical protocol consists only of portable values.

---

## 3.2 Schema is the protocol source of truth

Do not separately maintain:

- TypeScript interfaces
- validators
- JSON schemas
- serializers
- test generators

Define the canonical format with Effect Schema and derive the rest.

```text
Effect Schema
   ├── TypeScript type
   ├── runtime decoder
   ├── encoder
   ├── JSON Schema
   ├── Standard Schema
   └── property-test arbitraries
```

---

## 3.3 Stream is the canonical event abstraction

Do not make arrays or promises the primary event abstraction.

Use:

```ts
Stream.Stream<SessionEvent, BridgeError, Requirements>
```

Historical sessions and live sessions should eventually produce the same stream shape.

```text
historical JSONL ─┐
SQLite history ───┤
ACP stream ───────┼──▶ Stream<SessionEvent>
native API ───────┤
process hooks ────┘
```

---

## 3.4 Errors are data

Adapters must not throw ordinary `Error` values for expected failures.

Use explicit domain errors.

Examples:

```text
HarnessNotInstalled
SessionNotFound
UnsupportedSessionVersion
SessionParseError
SessionReadError
PermissionDenied
MalformedSource
AdapterUnavailable
StoreError
ExportError
```

---

## 3.5 Capability-driven behavior

Consumers should ask what an adapter supports.

They should not branch primarily on provider names.

Bad:

```ts
if (session.harness === "claude-code") {
  ...
}
```

Better:

```ts
if (session.capabilities.live) {
  ...
}
```

---

# 4. Repository Structure

Recommended monorepo:

```text
bridge/
├── packages/
│
│   ├── schema/
│   │   ├── src/
│   │   │   ├── ids.ts
│   │   │   ├── content.ts
│   │   │   ├── session.ts
│   │   │   ├── events.ts
│   │   │   ├── source.ts
│   │   │   ├── capabilities.ts
│   │   │   ├── relationships.ts
│   │   │   └── index.ts
│   │
│   ├── core/
│   │   ├── src/
│   │   │   ├── Bridge.ts
│   │   │   ├── HarnessRegistry.ts
│   │   │   ├── SessionStore.ts
│   │   │   ├── SessionEnricher.ts
│   │   │   ├── errors.ts
│   │   │   └── index.ts
│   │
│   ├── adapter-claude-code/
│   ├── adapter-codex/
│   ├── adapter-opencode/
│   ├── adapter-acp/
│   │
│   ├── store-memory/
│   ├── store-sqlite/
│   │
│   ├── platform-node/
│   ├── testing/
│   └── cli/
│
├── apps/
│   └── bridge-cli/
│
├── examples/
│   ├── inspect-session/
│   ├── export-session/
│   └── live-session/
│
├── docs/
│   ├── protocol.md
│   ├── adapter-authoring.md
│   └── architecture.md
│
└── package.json
```

The important dependency rule:

```text
schema
  ↑
core
  ↑
adapters / stores
  ↑
platform / CLI / applications
```

`schema` must not depend on adapters.

`core` must not depend on a specific harness.

Applications such as Replay should depend on Bridge Core, not directly on harness adapters.

---

# 5. Suggested Packages

Initial package names:

```text
@agentbridge/schema
@agentbridge/core

@agentbridge/adapter-claude-code
@agentbridge/adapter-codex
@agentbridge/adapter-opencode
@agentbridge/adapter-acp

@agentbridge/store-memory
@agentbridge/store-sqlite

@agentbridge/platform-node
@agentbridge/testing
@agentbridge/cli
```

The exact npm scope can be changed later.

---

# 6. IDs

Use branded schemas for public identifiers.

```ts
import { Schema } from "effect"

export const SessionId = Schema.String.pipe(
  Schema.brand("SessionId")
)

export type SessionId = typeof SessionId.Type

export const EventId = Schema.String.pipe(
  Schema.brand("EventId")
)

export type EventId = typeof EventId.Type

export const HarnessId = Schema.String.pipe(
  Schema.brand("HarnessId")
)

export type HarnessId = typeof HarnessId.Type
```

Other IDs:

```text
ToolCallId
CommandId
ArtifactId
RelationshipId
```

IDs should serialize to ordinary strings.

---

# 7. Timestamps

Use one canonical timestamp representation in the wire format.

Recommended:

```text
RFC 3339 / ISO 8601 UTC string
```

Example:

```json
"2026-09-13T17:31:42.391Z"
```

The in-memory model may decode into Effect's date/time representation if desirable, but encoded output must stay interoperable.

---

# 8. Source Reference

Every normalized event should retain provenance.

```ts
import { Schema } from "effect"

export class SourceReference extends Schema.Class<SourceReference>(
  "bridge/SourceReference"
)({
  provider: Schema.String,
  format: Schema.String,
  sourceId: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  nativeEventId: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String)
}) {}
```

Do **not** include arbitrary raw source data in every event by default.

Instead allow an optional raw-reference mechanism:

```ts
export class RawReference extends Schema.Class<RawReference>(
  "bridge/RawReference"
)({
  kind: Schema.String,
  locator: Schema.String
}) {}
```

This avoids duplicating large provider payloads in memory.

---

# 9. Certainty

Derived information must declare how authoritative it is.

```ts
export const Certainty = Schema.Literals([
  "known",
  "inferred",
  "unknown"
])

export type Certainty = typeof Certainty.Type
```

Example:

```text
Claude explicitly records a Bash invocation:
certainty = known

Bridge sees `git commit` in a shell command and derives a git.commit event:
certainty = inferred

A timestamp cannot be recovered:
certainty = unknown
```

---

# 10. Content Blocks

Messages should support structured content.

```ts
export class TextContent extends Schema.TaggedClass<TextContent>()(
  "text",
  {
    text: Schema.String
  }
) {}

export class CodeContent extends Schema.TaggedClass<CodeContent>()(
  "code",
  {
    code: Schema.String,
    language: Schema.optional(Schema.String)
  }
) {}

export class FileContent extends Schema.TaggedClass<FileContent>()(
  "file",
  {
    path: Schema.String
  }
) {}

export class ImageContent extends Schema.TaggedClass<ImageContent>()(
  "image",
  {
    uri: Schema.String,
    mimeType: Schema.optional(Schema.String)
  }
) {}

export const ContentBlock = Schema.Union([
  TextContent,
  CodeContent,
  FileContent,
  ImageContent
])
```

Wire data remains ordinary tagged JSON.

---

# 11. Session Schema

```ts
import { Schema } from "effect"

export const SessionStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown"
])

export class HarnessIdentity extends Schema.Class<HarnessIdentity>(
  "bridge/HarnessIdentity"
)({
  id: HarnessId,
  name: Schema.String,
  version: Schema.optional(Schema.String)
}) {}

export class SessionCapabilities extends Schema.Class<SessionCapabilities>(
  "bridge/SessionCapabilities"
)({
  history: Schema.Boolean,
  live: Schema.Boolean,
  resume: Schema.Boolean,
  toolCalls: Schema.Boolean,
  reasoning: Schema.Boolean,
  tokenUsage: Schema.Boolean,
  fileEvents: Schema.Boolean,
  commandEvents: Schema.Boolean
}) {}

export class Session extends Schema.Class<Session>(
  "bridge/Session"
)({
  id: SessionId,
  harness: HarnessIdentity,
  status: SessionStatus,
  title: Schema.optional(Schema.String),
  projectPath: Schema.optional(Schema.String),
  workspacePath: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(SessionId),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
  capabilities: SessionCapabilities,
  metadata: Schema.Record({
    key: Schema.String,
    value: Schema.Unknown
  })
}) {}
```

The final implementation should use the current Effect V4 API exactly as pinned in the repository.

---

# 12. Base Event Shape

Rather than forcing classical inheritance across every schema variant, define a reusable field object.

```ts
export const BaseEventFields = {
  id: EventId,
  sessionId: SessionId,
  sequence: Schema.Int,
  timestamp: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  parentEventId: Schema.optional(EventId),
  certainty: Certainty,
  source: SourceReference
}
```

---

# 13. Canonical Events

## Session lifecycle

```ts
export class SessionStarted extends Schema.TaggedClass<SessionStarted>()(
  "session.started",
  {
    ...BaseEventFields
  }
) {}

export class SessionCompleted extends Schema.TaggedClass<SessionCompleted>()(
  "session.completed",
  {
    ...BaseEventFields
  }
) {}

export class SessionFailed extends Schema.TaggedClass<SessionFailed>()(
  "session.failed",
  {
    ...BaseEventFields,
    message: Schema.optional(Schema.String)
  }
) {}
```

---

## Messages

```ts
export class UserMessage extends Schema.TaggedClass<UserMessage>()(
  "user.message",
  {
    ...BaseEventFields,
    content: Schema.Array(ContentBlock)
  }
) {}

export class AgentMessage extends Schema.TaggedClass<AgentMessage>()(
  "agent.message",
  {
    ...BaseEventFields,
    content: Schema.Array(ContentBlock)
  }
) {}
```

---

## Reasoning

```ts
export const ReasoningRepresentation = Schema.Literals([
  "summary",
  "provider_exposed"
])

export class AgentReasoning extends Schema.TaggedClass<AgentReasoning>()(
  "agent.reasoning",
  {
    ...BaseEventFields,
    content: Schema.String,
    representation: ReasoningRepresentation
  }
) {}
```

Bridge must never attempt to reconstruct hidden reasoning.

---

## Tool calls

```ts
export class ToolStarted extends Schema.TaggedClass<ToolStarted>()(
  "tool.started",
  {
    ...BaseEventFields,
    toolCallId: ToolCallId,
    name: Schema.String,
    input: Schema.optional(Schema.Unknown)
  }
) {}

export class ToolCompleted extends Schema.TaggedClass<ToolCompleted>()(
  "tool.completed",
  {
    ...BaseEventFields,
    toolCallId: ToolCallId,
    output: Schema.optional(Schema.Unknown)
  }
) {}

export class ToolFailed extends Schema.TaggedClass<ToolFailed>()(
  "tool.failed",
  {
    ...BaseEventFields,
    toolCallId: ToolCallId,
    message: Schema.String
  }
) {}
```

---

## Commands

```ts
export class CommandStarted extends Schema.TaggedClass<CommandStarted>()(
  "command.started",
  {
    ...BaseEventFields,
    commandId: CommandId,
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    shell: Schema.optional(Schema.String)
  }
) {}

export class CommandCompleted extends Schema.TaggedClass<CommandCompleted>()(
  "command.completed",
  {
    ...BaseEventFields,
    commandId: CommandId,
    exitCode: Schema.optional(Schema.Int),
    stdout: Schema.optional(Schema.String),
    stderr: Schema.optional(Schema.String)
  }
) {}
```

---

## Files

```ts
export class FileRead extends Schema.TaggedClass<FileRead>()(
  "file.read",
  {
    ...BaseEventFields,
    path: Schema.String
  }
) {}

export class FileChanged extends Schema.TaggedClass<FileChanged>()(
  "file.changed",
  {
    ...BaseEventFields,
    path: Schema.String,
    previousHash: Schema.optional(Schema.String),
    currentHash: Schema.optional(Schema.String),
    diff: Schema.optional(Schema.String),
    language: Schema.optional(Schema.String)
  }
) {}
```

Additional variants:

```text
file.created
file.deleted
patch.applied
```

---

# 14. SessionEvent Union

```ts
export const SessionEvent = Schema.Union([
  SessionStarted,
  SessionCompleted,
  SessionFailed,

  UserMessage,
  AgentMessage,
  AgentReasoning,

  ToolStarted,
  ToolCompleted,
  ToolFailed,

  CommandStarted,
  CommandCompleted,

  FileRead,
  FileChanged
])

export type SessionEvent = typeof SessionEvent.Type
export type EncodedSessionEvent = typeof SessionEvent.Encoded
```

This union is the central canonical contract.

---

# 15. Domain Errors

Use `Schema.TaggedError` for serializable / typed domain failures when appropriate.

```ts
import { Schema } from "effect"

export class HarnessNotInstalled extends Schema.TaggedError<HarnessNotInstalled>()(
  "HarnessNotInstalled",
  {
    harness: HarnessId
  }
) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  {
    sessionId: SessionId
  }
) {}

export class UnsupportedSessionVersion
  extends Schema.TaggedError<UnsupportedSessionVersion>()(
    "UnsupportedSessionVersion",
    {
      harness: HarnessId,
      version: Schema.String
    }
  ) {}

export class SessionParseError extends Schema.TaggedError<SessionParseError>()(
  "SessionParseError",
  {
    harness: HarnessId,
    path: Schema.String,
    message: Schema.String
  }
) {}

export class SessionReadError extends Schema.TaggedError<SessionReadError>()(
  "SessionReadError",
  {
    harness: HarnessId,
    path: Schema.optional(Schema.String),
    message: Schema.String
  }
) {}
```

Then:

```ts
export type AdapterError =
  | HarnessNotInstalled
  | SessionNotFound
  | UnsupportedSessionVersion
  | SessionParseError
  | SessionReadError
```

Avoid exposing raw library errors as the public contract.

---

# 16. Harness Capabilities

```ts
export class HarnessCapabilities extends Schema.Class<HarnessCapabilities>(
  "bridge/HarnessCapabilities"
)({
  historicalSessions: Schema.Boolean,
  liveSessions: Schema.Boolean,
  resumableSessions: Schema.Boolean,
  reasoning: Schema.Boolean,
  toolCalls: Schema.Boolean,
  commandEvents: Schema.Boolean,
  fileEvents: Schema.Boolean,
  tokenUsage: Schema.Boolean,
  subagents: Schema.Boolean
}) {}
```

Adapters should expose a static baseline plus session-specific capabilities if needed.

---

# 17. Adapter Contract

Adapters should be represented as services, not untyped objects passed through the application.

A provider-specific service can look like:

```ts
import { Context, Effect, Stream } from "effect"

export interface HarnessAdapterShape {
  readonly id: HarnessId

  readonly detect: Effect.Effect<
    DetectionResult,
    DetectionError
  >

  readonly capabilities: Effect.Effect<
    HarnessCapabilities
  >

  readonly listSessions: (
    options?: ListSessionsOptions
  ) => Stream.Stream<
    SessionDescriptor,
    SessionDiscoveryError
  >

  readonly loadSession: (
    ref: SessionReference
  ) => Effect.Effect<
    Session,
    SessionReadError | SessionParseError
  >

  readonly events: (
    ref: SessionReference
  ) => Stream.Stream<
    SessionEvent,
    SessionReadError | SessionParseError
  >

  readonly watch?: (
    ref: SessionReference
  ) => Stream.Stream<
    SessionEvent,
    SessionWatchError
  >
}
```

The concrete service may be declared with `Context.Service`.

---

# 18. Harness Registry

Bridge needs a central service that aggregates adapters.

```ts
import { Context, Effect, Stream } from "effect"

export class HarnessRegistry extends Context.Service<HarnessRegistry>()(
  "bridge/HarnessRegistry",
  {
    effect: Effect.gen(function* () {
      // registry construction
      return {
        adapters: [] as ReadonlyArray<HarnessAdapterShape>
      }
    })
  }
) {}
```

The actual construction may use a simpler Layer-supplied collection if that is easier with the pinned Effect V4 API.

Responsibilities:

```text
register adapters
detect available harnesses
find adapter by harness ID
fan out session discovery
deduplicate sessions
aggregate errors where appropriate
```

---

# 19. Bridge Service

The main public service should remain small.

Conceptual API:

```ts
export interface BridgeShape {
  readonly harnesses: {
    readonly detect: Effect.Effect<
      ReadonlyArray<DetectedHarness>,
      DetectionError
    >
  }

  readonly sessions: {
    readonly list: (
      options?: ListSessionsOptions
    ) => Stream.Stream<
      SessionDescriptor,
      BridgeError
    >

    readonly get: (
      id: SessionId
    ) => Effect.Effect<
      Session,
      BridgeError
    >

    readonly events: (
      id: SessionId
    ) => Stream.Stream<
      SessionEvent,
      BridgeError
    >

    readonly watch: (
      id: SessionId
    ) => Stream.Stream<
      SessionEvent,
      BridgeError
    >

    readonly export: (
      id: SessionId,
      destination: string
    ) => Effect.Effect<
      void,
      ExportError
    >
  }
}
```

Applications should generally talk to this service.

---

# 20. Service Construction

Use `Context.Service` plus static Layers.

Conceptually:

```ts
export class Bridge extends Context.Service<Bridge>()(
  "bridge/Bridge",
  {
    effect: Effect.gen(function* () {
      const registry = yield* HarnessRegistry
      const store = yield* SessionStore

      return {
        // implementation
      }
    })
  }
) {
  static readonly layerWithoutDependencies = Layer.effect(
    this,
    this.effect
  )
}
```

Final syntax should follow the pinned Effect V4 version.

---

# 21. Layers

The entire runtime should compose from Layers.

Example target:

```ts
const BridgeNodeLive = Layer.mergeAll(
  ClaudeCodeAdapter.layer,
  CodexAdapter.layer,
  OpenCodeAdapter.layer,
  SqliteSessionStore.layer,
  NodePlatform.layer
)
```

Then:

```ts
program.pipe(
  Effect.provide(BridgeNodeLive)
)
```

For tests:

```ts
const BridgeTest = Layer.mergeAll(
  FakeClaudeAdapter.layer,
  MemorySessionStore.layer,
  TestPlatform.layer
)
```

No production code should manually instantiate hidden global singletons.

---

# 22. Platform Abstractions

Adapters should depend on Effect Platform abstractions wherever practical.

Prefer:

```text
FileSystem
Path
Command / process abstraction
Terminal
```

over:

```text
node:fs
node:path
child_process
```

inside domain packages.

Node-specific dependencies should be wired at the application boundary.

This makes adapters easier to test and leaves room for Bun or other runtime support.

---

# 23. Historical Event Pipeline

A historical adapter should roughly follow:

```text
source
  │
  ▼
read bytes / rows
  │
  ▼
split records
  │
  ▼
decode provider schema
  │
  ▼
normalize provider record
  │
  ▼
canonical SessionEvent
  │
  ▼
optional enrichment
  │
  ▼
Stream<SessionEvent>
```

Effect shape:

```ts
const events = source.pipe(
  Stream.mapEffect(decodeProviderRecord),
  Stream.mapEffect(normalizeRecord),
  Stream.flatMap(toCanonicalEvents)
)
```

Avoid loading the full source into memory if the provider format is naturally streamable.

---

# 24. Provider Schemas

Each adapter should define its own internal provider schemas.

Example:

```text
adapter-claude-code/
├── source/
│   ├── ClaudeRecord.ts
│   ├── ClaudeToolUse.ts
│   ├── ClaudeMessage.ts
│   └── ClaudeSession.ts
```

Never decode provider data directly into canonical schemas.

Use:

```text
unknown source
   ↓
provider schema
   ↓
provider model
   ↓
normalizer
   ↓
canonical model
```

This creates a clean compatibility boundary.

---

# 25. Claude Code Adapter

The first vertical slice should support Claude Code historical sessions.

Package:

```text
@agentbridge/adapter-claude-code
```

Structure:

```text
src/
├── ClaudeCodeAdapter.ts
├── ClaudeCodePaths.ts
├── ClaudeCodeSource.ts
├── ClaudeCodeNormalizer.ts
├── ClaudeCodeCapabilities.ts
├── errors.ts
│
├── schema/
│   ├── ClaudeRecord.ts
│   ├── ClaudeMessage.ts
│   ├── ClaudeToolUse.ts
│   └── index.ts
│
└── test/
    └── fixtures/
```

---

# 26. Claude Detection

Detection should answer:

```ts
export class DetectionResult extends Schema.Class<DetectionResult>(
  "bridge/DetectionResult"
)({
  harness: HarnessId,
  installed: Schema.Boolean,
  version: Schema.optional(Schema.String),
  historyAvailable: Schema.Boolean,
  paths: Schema.Array(Schema.String)
}) {}
```

Claude detection may inspect:

```text
known binary location / PATH
known session directories
configuration directories
```

Do not read or surface credentials.

Detection failure for one signal should not necessarily fail the entire detection operation.

---

# 27. Claude Session Discovery

Conceptual implementation:

```ts
const listSessions = (
  options?: ListSessionsOptions
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* ClaudeCodePaths

      return discoverClaudeSessionFiles(fs, paths, options)
    })
  )
```

Each session descriptor should be cheap to construct.

Avoid fully parsing every history file during listing.

---

# 28. Claude Raw Record Decoder

Example shape:

```ts
const ClaudeRecord = Schema.Union([
  ClaudeUserRecord,
  ClaudeAssistantRecord,
  ClaudeToolUseRecord,
  ClaudeToolResultRecord,
  ClaudeSystemRecord,
  ClaudeUnknownRecord
])
```

Unknown records should be preserved or represented safely rather than making the whole session unreadable.

The adapter should be forward-compatible where possible.

---

# 29. Claude Normalizer

The normalizer is a pure mapping layer where practical.

Conceptual functions:

```ts
normalizeUserMessage(
  record: ClaudeUserRecord,
  context: NormalizationContext
): ReadonlyArray<SessionEvent>

normalizeAssistantMessage(...)

normalizeToolUse(...)

normalizeToolResult(...)

normalizeUnknownRecord(...)
```

The mapping layer should not perform filesystem I/O unless enrichment requires it.

---

# 30. Tool Normalization

Provider-specific tool names should map to semantic canonical events where possible.

For example:

```text
Claude Bash tool
  ├── tool.started
  └── command.started

Claude Bash tool result
  ├── tool.completed
  └── command.completed
```

A tool can therefore produce both generic and semantic events.

The relationship should be explicit:

```text
tool.started
    │
    └── parent / derived relationship
            │
            ▼
      command.started
```

This allows:

- generic tool inspectors
- semantic terminal views

to consume the same session.

---

# 31. Event Derivation

Derived events need provenance.

Add:

```ts
derivedFrom: Schema.optional(
  Schema.Array(EventId)
)
```

to canonical events or a reusable metadata block.

Example:

```text
native Claude Bash tool record
        │
        ├── tool.started      known
        │
        └── command.started   known
```

Later:

```text
command: git commit -m "fix"
        │
        └── git.commit        inferred
```

---

# 32. Sequencing

Canonical events must have deterministic ordering.

The adapter should assign:

```ts
sequence: number
```

Rules:

1. preserve provider order when reliable
2. use native timestamps as secondary information, not sole ordering
3. derived child events should be placed deterministically next to their source event
4. sequence values should not change between repeated imports unless the underlying source changes

Do not rely solely on wall-clock timestamps.

---

# 33. Stable Event IDs

Prefer native IDs when available.

Conceptual algorithm:

```text
if nativeEventId exists:
  eventId = hash(harness + session + nativeEventId + canonicalType)

else:
  eventId = hash(
    harness +
    session +
    sourceRecordIndex +
    canonicalType +
    derivationIndex
  )
```

The canonical hash algorithm should be documented.

Do not use random UUIDs for historical imports.

Repeated imports should generate identical IDs.

---

# 34. Unknown Provider Data

Bridge should be resilient to new provider record types.

Adapter policy:

```text
known + valid
  → normalize

known + malformed
  → typed parsing error or partial-session warning

unknown
  → preserve provenance
  → optionally emit custom provider event
  → continue session where safe
```

One unknown Claude Code event should not necessarily destroy an entire 4-hour session.

---

# 35. Partial Session Semantics

Bridge should support partially readable sessions.

Add warnings at session import level.

Conceptual type:

```ts
export class ImportWarning extends Schema.Class<ImportWarning>(
  "bridge/ImportWarning"
)({
  code: Schema.String,
  message: Schema.String,
  source: Schema.optional(SourceReference)
}) {}
```

Consumers can then display:

```text
Session loaded with 2 compatibility warnings.
```

instead of receiving only success/failure.

---

# 36. Session Store Service

```ts
export interface SessionStoreShape {
  readonly putSession: (
    session: Session
  ) => Effect.Effect<void, StoreError>

  readonly putEvents: (
    sessionId: SessionId,
    events: ReadonlyArray<SessionEvent>
  ) => Effect.Effect<void, StoreError>

  readonly getSession: (
    id: SessionId
  ) => Effect.Effect<
    Option.Option<Session>,
    StoreError
  >

  readonly events: (
    id: SessionId
  ) => Stream.Stream<
    SessionEvent,
    StoreError
  >

  readonly query: (
    query: SessionQuery
  ) => Stream.Stream<
    Session,
    StoreError
  >
}
```

---

# 37. Memory Store

The first implementation should include:

```text
@agentbridge/store-memory
```

Use cases:

- tests
- examples
- ephemeral CLI operations
- application prototypes

It should implement the exact same service as SQLite.

---

# 38. SQLite Store

SQLite should be the first persistent reference store.

Potential schema:

```text
sessions
--------
id
harness_id
native_id
status
title
project_path
started_at
ended_at
encoded_json

events
------
id
session_id
sequence
type
timestamp
encoded_json

import_sources
--------------
harness_id
source_path
fingerprint
cursor
updated_at
```

Indexes:

```text
events(session_id, sequence)
sessions(harness_id)
sessions(project_path)
sessions(started_at)
```

Do not prematurely normalize every event property into relational columns.

The canonical encoded event can remain JSON while commonly queried fields are indexed separately.

---

# 39. Effect SQL

If Effect SQL + the selected SQLite implementation is mature enough for the pinned Effect V4 release, prefer it for the reference store.

Otherwise preserve the `SessionStore` boundary and use a small adapter around the chosen SQLite driver.

Storage technology must not leak into Bridge Core.

---

# 40. Streaming From Store

Do not make:

```ts
getEvents(): Effect<SessionEvent[]>
```

the primary API.

Use:

```ts
events(): Stream.Stream<SessionEvent, StoreError>
```

This allows:

- large sessions
- incremental consumers
- Replay playback
- Lessons analysis pipelines
- future remote backends

without changing the contract.

---

# 41. Enrichers

Enrichers should be composable stream transformations.

```ts
export interface SessionEnricherShape {
  readonly enrich: (
    session: Session,
    events: Stream.Stream<SessionEvent, BridgeError>
  ) => Stream.Stream<SessionEvent, BridgeError>
}
```

Examples:

```text
GitEnricher
DiffEnricher
LanguageEnricher
ProjectEnricher
RedactionEnricher
```

LLM-based interpretation does **not** belong in Bridge Core.

---

# 42. Git Enricher

The Git enricher can observe canonical command events.

Example:

```text
command.started
command = "git commit -m ..."
       │
       ▼
GitEnricher
       │
       ▼
git.commit
certainty = inferred
derivedFrom = [commandEventId]
```

Later, repository inspection may upgrade certainty if the exact commit can be verified.

---

# 43. Redaction

Redaction should be opt-in at read/export boundaries.

Do not mutate original provider histories.

Service:

```ts
export interface RedactorShape {
  readonly redact: (
    event: SessionEvent
  ) => Effect.Effect<SessionEvent, RedactionError>
}
```

Potential default detectors:

```text
GitHub tokens
AWS keys
Bearer tokens
private key blocks
.env values
common API key patterns
```

Never claim redaction is perfect.

---

# 44. Live Sessions

Historical and live adapters should converge on the same event type.

```text
Historical
source file
    │
    ▼
normalize
    │
    ▼
SessionEvent stream

Live
ACP
 │
 ▼
normalize
 │
 ▼
SessionEvent stream
```

Consumers should not need separate rendering architectures.

---

# 45. ACP Adapter

ACP should be treated as a preferred live transport where available.

Package:

```text
@agentbridge/adapter-acp
```

Mapping concept:

```text
ACP agent message
  → agent.message

ACP thought / exposed reasoning
  → agent.reasoning

ACP tool call
  → tool.started

ACP tool update / completion
  → tool.completed / tool.failed

ACP plan
  → plan.updated
```

Bridge adds:

```text
canonical serialization
persistent history
cross-provider normalization
git / filesystem enrichment
portable session export
```

It should not reinvent ACP's transport semantics.

---

# 46. Concurrency

Harness discovery is naturally concurrent.

Conceptually:

```ts
Stream.fromIterable(adapters).pipe(
  Stream.mapEffect(
    adapter => adapter.detect,
    { concurrency: "unbounded" }
  )
)
```

Use bounded concurrency where filesystem pressure could become significant.

Do not manually maintain promise pools if Effect already models the concurrency requirement.

---

# 47. Cancellation

Long-running operations must respect Effect cancellation:

```text
session watch
filesystem watcher
process tail
ACP connection
database stream
```

No adapter should spawn unmanaged background work.

Resource acquisition should use scoped Effect APIs.

---

# 48. Resource Safety

Any resource with lifecycle semantics must be scoped:

```text
file handle
database connection
filesystem watcher
child process
ACP socket
```

Conceptually:

```ts
Effect.acquireRelease(
  acquire,
  release
)
```

Streams built from resources should close them when:

- completed
- failed
- interrupted

---

# 49. Retries

Retries should be narrow.

Good candidates:

```text
temporarily locked SQLite DB
transient live transport failure
temporary file access race
```

Bad candidates:

```text
invalid JSON forever
unsupported provider version
missing required source file
```

Retry policy belongs near infrastructure boundaries, not inside schema decoding.

---

# 50. Observability

Bridge should use Effect-native tracing/logging internally where appropriate.

Useful spans:

```text
bridge.detect-harnesses
bridge.list-sessions
bridge.load-session
bridge.decode-session
bridge.normalize-session
bridge.store-session
bridge.export-session
```

Attributes:

```text
harness
session_id
provider_version
event_count
warning_count
duration
```

Never attach sensitive prompt or source contents to telemetry by default.

---

# 51. Public SDK API

Consumers should have a high-level API.

Desired usage:

```ts
import { Effect, Stream } from "effect"
import { Bridge } from "@agentbridge/core"

const program = Effect.gen(function* () {
  const bridge = yield* Bridge

  return bridge.sessions.list()
})
```

Or expose convenience functions:

```ts
Bridge.sessions.list(...)
Bridge.sessions.events(...)
Bridge.sessions.export(...)
```

depending on what proves idiomatic with the pinned Effect V4 version.

The public API should optimize for:

```text
discover
list
open
stream
watch
export
```

---

# 52. Convenience Runtime

A Node convenience package may provide a batteries-included runtime.

Example:

```ts
import { NodeBridge } from "@agentbridge/platform-node"

const runtime = NodeBridge.runtime({
  adapters: [
    "claude-code",
    "codex",
    "opencode"
  ]
})
```

But this convenience layer should be built on the same services and Layers.

---

# 53. CLI

The CLI is primarily:

- reference consumer
- debugging tool
- adapter verification tool
- interoperability surface

Commands:

```bash
bridge harnesses

bridge sessions

bridge sessions --harness claude-code

bridge show <session-id>

bridge events <session-id>

bridge watch <session-id>

bridge export <session-id>

bridge doctor
```

JSON output:

```bash
bridge sessions --json
bridge events <id> --jsonl
```

The CLI must use Bridge APIs rather than duplicating parsing logic.

---

# 54. `bridge doctor`

This should be a first-class developer command.

Output example:

```text
Bridge Doctor

✓ Claude Code detected
  version: ...
  history: available
  path: ...

✓ Codex detected
  version: ...
  history: available

○ OpenCode not detected

Schema version: 1
Storage: SQLite
Database: healthy
```

Adapter authors should use this to debug environment assumptions.

---

# 55. Export Format

Initial canonical export:

```text
.bridge/
├── session.json
├── events.jsonl
└── manifest.json
```

`manifest.json`:

```json
{
  "format": "bridge-session",
  "version": 1
}
```

`session.json`:

```json
{
  "id": "...",
  "harness": {
    "id": "claude-code",
    "name": "Claude Code"
  }
}
```

`events.jsonl`:

```json
{"_tag":"user.message", "...":"..."}
{"_tag":"agent.message", "...":"..."}
{"_tag":"tool.started", "...":"..."}
```

If the canonical discriminator is named `type` instead of `_tag`, the encoding layer should deliberately transform the internal Effect representation.

Do not let Effect's preferred in-memory naming dictate the long-term wire format accidentally.

---

# 56. Wire Discriminator Decision

Recommended external field:

```json
"type": "user.message"
```

Recommended internal Effect tag may remain:

```ts
_tag
```

Use an encoding transformation if needed.

Reason:

`type` is friendlier for:

- non-Effect SDKs
- JSON tooling
- event consumers
- other languages

Treat the wire format as an independent public API.

---

# 57. JSON Schema

Generate and publish JSON Schema for:

```text
Session
SessionEvent
BridgeSessionManifest
```

Recommended paths:

```text
schemas/v1/session.schema.json
schemas/v1/event.schema.json
schemas/v1/manifest.schema.json
```

Publish them with releases.

Third-party tools should be able to validate Bridge session files without using TypeScript.

---

# 58. Testing Strategy

Bridge needs unusually strong fixture-driven testing.

Layers:

```text
1. schema tests
2. adapter fixture tests
3. normalization tests
4. property tests
5. store contract tests
6. cross-adapter canonical tests
7. integration tests
```

---

# 59. Schema Tests

For every canonical schema:

```text
decode valid
reject invalid
encode
decode(encode(value))
JSON schema generation
```

Where practical:

```text
encode → decode round trip
```

must preserve semantic equality.

---

# 60. Property Tests

Effect Schema can support generated values / arbitraries.

Use property testing for:

```text
canonical event round trips
ID invariants
session ordering invariants
serialization invariants
store round trips
```

---

# 61. Adapter Fixtures

Never make the core adapter test suite depend solely on whatever files happen to exist on a developer's laptop.

Check sanitized fixtures into the repository.

Example:

```text
fixtures/
├── claude/
│   ├── simple-chat/
│   ├── bash-command/
│   ├── file-edit/
│   ├── failed-tool/
│   ├── unknown-event/
│   └── long-session/
```

Each fixture contains:

```text
raw provider history
expected canonical events
```

---

# 62. Golden Tests

For important sessions:

```text
provider input
     ↓
adapter
     ↓
canonical JSONL
     ↓
compare with golden file
```

This makes provider-format regressions obvious.

---

# 63. Cross-Adapter Contract Tests

The strongest Bridge test is semantic equivalence.

Construct conceptually equivalent sessions for Claude and Codex:

```text
user asks to edit README
agent reads file
agent changes file
agent runs tests
session completes
```

Both should normalize into substantially equivalent event sequences.

This tests the abstraction, not just parsers.

---

# 64. Session Store Contract Suite

Every SessionStore implementation must pass the same test suite:

```text
put/get session
ordered event retrieval
query filtering
overwrite / idempotency behavior
large event sequence
missing session
stream interruption
```

Run the suite against:

```text
MemorySessionStore
SqliteSessionStore
```

---

# 65. Adapter Contract Suite

Each adapter should pass shared expectations:

```text
stable session IDs
stable event IDs
monotonic sequence
valid canonical schema
correct source metadata
no credential exposure
unknown event handling
stream completion
```

---

# 66. First Claude Code Vertical Slice

The first milestone is not "support Claude Code."

It is:

> Prove that the canonical model is useful by building one end-to-end path.

Scope:

```text
discover Claude Code
      ↓
list session files
      ↓
pick one session
      ↓
decode records
      ↓
normalize
      ↓
Stream<SessionEvent>
      ↓
CLI JSONL
```

Required events:

```text
session.started
user.message
agent.message
tool.started
tool.completed
command.started
command.completed
session.completed
```

File events can follow immediately after.

---

# 67. Claude Code Adapter Skeleton

Conceptual implementation:

```ts
import {
  Context,
  Effect,
  Layer,
  Stream
} from "effect"

import {
  FileSystem,
  Path
} from "effect"

export class ClaudeCodeAdapter
  extends Context.Service<ClaudeCodeAdapter>()(
    "bridge/ClaudeCodeAdapter",
    {
      effect: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const detect = Effect.gen(function* () {
          // inspect known locations
          // optionally inspect PATH
          // return DetectionResult
        })

        const listSessions = (
          options?: ListSessionsOptions
        ) =>
          discoverClaudeSessions({
            fs,
            path,
            options
          })

        const loadSession = (
          ref: SessionReference
        ) =>
          parseClaudeSession({
            fs,
            ref
          })

        const events = (
          ref: SessionReference
        ) =>
          readClaudeRecords({
            fs,
            ref
          }).pipe(
            Stream.mapEffect(decodeClaudeRecord),
            Stream.mapAccum(
              initialNormalizationState(ref),
              normalizeClaudeRecord
            ),
            Stream.flatMap(Stream.fromIterable)
          )

        return {
          id: "claude-code",
          detect,
          listSessions,
          loadSession,
          events
        } as const
      })
    }
  ) {}
```

This is intentionally a skeleton.

Use the exact APIs exposed by the pinned Effect V4 version while implementing.

---

# 68. Normalization State

Some records require context from prior records.

Use explicit state.

```ts
interface NormalizationState {
  readonly sessionId: SessionId
  readonly sourceIndex: number
  readonly nextSequence: number

  readonly openTools: ReadonlyMap<
    string,
    ToolCallId
  >

  readonly openCommands: ReadonlyMap<
    string,
    CommandId
  >
}
```

Do not hide cross-record state in mutable module globals.

Use:

```text
Stream.mapAccum
Ref
SynchronizedRef
```

depending on the problem.

Prefer pure accumulation when possible.

---

# 69. Live State

Live normalization may require mutable state over time.

Use Effect-managed concurrency primitives rather than arbitrary JS mutation where concurrent access is possible.

Examples:

```text
Ref
SynchronizedRef
Queue
PubSub
```

Only introduce them when required.

Historical parsers should remain mostly pure.

---

# 70. Pub/Sub

Bridge Core does not initially need a global event bus.

If multiple consumers later need one live session stream, an optional daemon can use Effect primitives such as:

```text
PubSub
Queue
Hub-like fanout semantics
```

Do not build this before there is a demonstrated need.

---

# 71. Daemon Boundary

If introduced later:

```text
EmbeddedBridgeBackend
DaemonBridgeBackend
```

should implement equivalent domain behavior.

Conceptual:

```ts
interface BridgeBackend {
  listSessions(...)
  getSession(...)
  events(...)
  watch(...)
}
```

This lets applications switch deployment mode without changing their domain code.

---

# 72. Versioning

Protocol version and package version are separate concepts.

Example:

```text
npm package:
@agentbridge/schema@0.7.2

wire protocol:
bridge schema v1
```

Do not increment wire versions simply because implementation packages release.

---

# 73. Schema Evolution

Rules for wire schema v1:

Allowed without a new major wire version:

```text
new optional fields
new optional metadata
new event variants if consumers are expected to tolerate unknown events
```

Potentially breaking:

```text
renaming event types
removing fields
changing field semantics
changing ID derivation
changing ordering guarantees
```

Unknown event handling must be part of the protocol design from day one.

---

# 74. Custom Events

Canonical schema cannot anticipate every provider capability.

Support provider extension events.

Wire example:

```json
{
  "type": "custom.claude-code.foo",
  "sessionId": "...",
  "payload": {}
}
```

Rules:

```text
custom.<namespace>.<event>
```

Applications may ignore custom events safely.

Events that become broadly useful can later graduate into the canonical model.

---

# 75. Compatibility Warnings

Session loading should distinguish:

```text
fatal errors
warnings
ignored records
```

Potential result shape:

```ts
interface LoadedSession {
  readonly session: Session
  readonly warnings: ReadonlyArray<ImportWarning>
  readonly events: Stream.Stream<SessionEvent, BridgeError>
}
```

A slightly malformed provider history should often remain usable.

---

# 76. Security Boundary

Bridge processes developer histories and potentially proprietary source data.

Defaults:

```text
local only
no cloud
no content telemetry
no remote analytics
no API keys required
no model calls
no automatic upload
```

Bridge must not depend on an LLM.

Lessons may depend on AI later, but that is a separate product boundary.

---

# 77. Path Handling

Normalize path identity carefully.

A session can contain:

```text
relative paths
absolute paths
symlinks
worktrees
renamed projects
deleted projects
```

Canonical events should preserve the source path as observed.

Optional resolution metadata can be added separately.

Do not silently rewrite provider paths in a way that loses provenance.

---

# 78. Git Worktrees

Project identity should not be naïvely based on folder name.

Future `ProjectReference` should support:

```text
root path
git common directory
worktree path
remote URL if available
repository identity
```

This is especially important for agent-heavy workflows using isolated worktrees.

---

# 79. Session Relationships

Model:

```ts
export const SessionRelationshipType = Schema.Literals([
  "parent",
  "child",
  "resume",
  "fork",
  "delegate",
  "related"
])
```

Subagents should preferably become separate sessions with relationships if the source gives them stable identities.

Do not flatten meaningful agent boundaries into one giant event sequence.

---

# 80. Consumers

## Replay

Replay should consume:

```text
Session
Stream<SessionEvent>
```

Mapping:

```text
agent/user messages → conversation
commands            → terminal
file events         → diff / canvas
tools               → tool inspector
timestamps          → timeline
relationships       → session graph
```

Replay must contain **zero Claude-specific parsing**.

---

## Lessons

Lessons should consume canonical sessions and build a separate semantic analysis layer:

```text
canonical events
      ↓
session understanding
      ↓
goal extraction
      ↓
concept extraction
      ↓
decisions / mistakes
      ↓
lesson / quiz generation
```

No educational semantics belong in Bridge.

---

## Deck

Deck may use Bridge to:

```text
discover harnesses
observe active work
associate work with sessions
persist execution history
inspect finished work
consume strong signals
```

Deck retains responsibility for:

```text
agents
roles
routing
orchestration
policies
tasks
teams
```

---

# 81. First Milestones

## M0 — Protocol

Ship:

```text
@agentbridge/schema
```

with:

```text
Session
SessionEvent
SourceReference
Capabilities
IDs
Errors / warnings where appropriate
JSON Schema generation
serialization tests
```

No harness adapters yet.

Success:

```text
canonical fixture sessions validate and round-trip
```

---

## M1 — Claude Code

Ship:

```text
@agentbridge/adapter-claude-code
@agentbridge/cli
```

Support:

```text
detect
list historical sessions
load session
stream normalized events
JSONL output
```

Success:

```bash
bridge sessions --harness claude-code
bridge events <id> --jsonl
```

---

## M2 — Codex

Add Codex adapter.

Success criterion:

> The same CLI and test consumer work with Claude Code and Codex without provider-specific branches.

This is the first serious validation of the abstraction.

---

## M3 — OpenCode

Add OpenCode.

Revisit canonical abstractions only if real differences force it.

Do not add fields speculatively.

---

## M4 — Replay Migration

Replace Replay's harness-specific ingestion with Bridge.

Hard success criterion:

> Replay imports no provider parser directly.

This proves Bridge is a useful application boundary.

---

## M5 — Persistent Index

Add:

```text
@agentbridge/store-sqlite
```

plus:

```text
incremental imports
fingerprints
source cursors
query API
```

---

## M6 — ACP Live

Add:

```text
@agentbridge/adapter-acp
```

Prove:

```text
historical session events
and
live ACP events
```

can feed the same Replay UI.

---

# 82. MVP Non-Goals

Do not add to v0.1:

```text
daemon
cloud sync
remote sessions
team collaboration
agent orchestration
LLM analysis
vector database
semantic search
MCP server
web dashboard
authentication
plugin marketplace
distributed tracing backend
```

Bridge v0.1 should be boring and dependable.

---

# 83. `package.json` Direction

Conceptual workspace dependencies:

```json
{
  "dependencies": {
    "effect": "<pinned-v4-version>"
  }
}
```

Runtime packages add only what they need.

Example Node package:

```json
{
  "dependencies": {
    "effect": "<pinned-v4-version>",
    "@effect/platform-node": "<compatible-version>"
  }
}
```

SQLite package may add Effect SQL packages where compatible.

Pin exact Effect V4 release candidate versions during early development.

Avoid loose ranges until V4 stabilizes.

---

# 84. TypeScript Configuration

Recommended:

```text
strict: true
noUncheckedIndexedAccess: true
exactOptionalPropertyTypes: true
verbatimModuleSyntax: true
```

Treat type errors in canonical schema code as design feedback.

---

# 85. Formatting / Linting

Keep infrastructure minimal.

Good default:

```text
Biome
TypeScript
Vitest or Effect-compatible testing stack
```

Avoid adding tooling that duplicates Effect's strengths.

---

# 86. Documentation Generated From Code

The canonical schema should drive:

```text
JSON Schema
event reference
event examples
compatibility matrix
```

Where possible, attach annotations to schemas so protocol documentation can eventually be generated.

---

# 87. Adapter Compatibility Matrix

Publish something like:

| Capability | Claude Code | Codex | OpenCode | ACP |
|---|---:|---:|---:|---:|
| Detect | ✓ | ✓ | ✓ | n/a |
| Historical sessions | ✓ | ✓ | ✓ | provider-dependent |
| Live stream | later | later | later | ✓ |
| Messages | ✓ | ✓ | ✓ | ✓ |
| Tools | ✓ | ✓ | ✓ | ✓ |
| Commands | ✓ | ✓ | ✓ | normalized |
| File changes | partial | partial | partial | provider-dependent |
| Usage | provider-dependent | provider-dependent | provider-dependent | provider-dependent |
| Reasoning summaries | provider-dependent | provider-dependent | provider-dependent | provider-dependent |

Capability values must reflect actual implementation, not marketing assumptions.

---

# 88. Adapter Authoring Contract

A new adapter should need to implement:

```text
1. detection
2. source discovery
3. provider schemas
4. session metadata normalization
5. event normalization
6. stable ID strategy
7. capabilities
8. fixture suite
9. compatibility tests
```

It should not need to understand:

```text
Replay
Lessons
Deck
SQLite
CLI rendering
```

---

# 89. Adapter Quality Bar

An adapter is not considered supported until:

```text
✓ detection works
✓ historical discovery works
✓ fixture tests exist
✓ malformed input is typed
✓ unknown input is handled
✓ canonical schema validates
✓ IDs are stable
✓ event sequence is deterministic
✓ no credentials are exposed
✓ compatibility matrix is updated
```

---

# 90. North Star API

The developer experience should ultimately feel like:

```ts
const program = Effect.gen(function* () {
  const bridge = yield* Bridge

  const sessions = bridge.sessions.list()

  yield* sessions.pipe(
    Stream.runForEach((session) =>
      Console.log(session.id)
    )
  )
})
```

And:

```ts
const replay = bridge.sessions.events(sessionId).pipe(
  Stream.runForEach(renderEvent)
)
```

The application should not care whether the event originated from:

```text
Claude JSONL
Codex rollout
OpenCode database
ACP
future harness
```

---

# 91. Architectural Test

The central design test is:

```ts
switch (session.harness.id) {
  case "claude-code":
  case "codex":
  case "opencode":
}
```

If this starts appearing throughout Replay or Lessons, Bridge is leaking.

Provider branching should live at:

```text
adapter boundary
```

not:

```text
consumer boundary
```

---

# 92. Effect-Specific Architectural Test

Likewise, the wire protocol must not require:

```ts
Effect.runPromise(...)
```

to understand a saved Bridge session.

This should work in:

```text
TypeScript without Effect
Rust
Python
Go
Swift
Ruby
```

because the saved representation is plain JSON / JSONL plus a documented schema.

Effect is the best implementation environment for Bridge.

It is not the Bridge protocol.

---

# 93. Recommended First Implementation Order

Build in this exact order:

```text
1. repository + packages

2. @agentbridge/schema
   - IDs
   - session
   - base events
   - messages
   - tools
   - commands
   - files

3. canonical JSON fixtures

4. encode/decode tests

5. @agentbridge/core
   - typed errors
   - adapter contract
   - registry
   - Bridge service

6. @agentbridge/store-memory

7. @agentbridge/adapter-claude-code
   - detect
   - discover
   - provider schemas
   - normalizer

8. bridge CLI
   - harnesses
   - sessions
   - events

9. Codex adapter

10. cross-adapter semantic tests

11. migrate Replay to Bridge

12. only then revisit missing primitives
```

Do **not** begin with the daemon.

Do **not** begin with SQLite.

Do **not** begin with every harness.

The first architectural proof is:

> Two different harnesses produce one useful canonical stream.

---

# 94. Definition of Done for v0.1

Bridge v0.1 is done when:

```bash
bridge harnesses
```

can detect at least Claude Code and Codex,

and:

```bash
bridge sessions
```

can list sessions from both,

and:

```bash
bridge events <session-id> --jsonl
```

produces valid canonical events,

and the same small Replay consumer can render sessions from both without:

```ts
if (provider === ...)
```

logic.

No daemon is required.

No server is required.

No LLM is required.

No cloud is required.

---

# 95. Technical Thesis

Bridge should embody this architectural statement:

> Coding-agent harnesses are implementations. Sessions are the durable primitive.

Effect V4 gives Bridge the right internal machinery:

```text
Schema  → protocol
Stream  → session flow
Effect  → computation
Layer   → runtime composition
Context → services
Platform → OS boundaries
SQL     → optional persistence
```

But the durable public artifact stays simple:

```text
Session
+
ordered SessionEvent stream
+
portable JSON representation
```

That is the boundary Deck, Replay, Lessons, CTO, and third-party applications should build on.

---

# 96. North Star

A consumer should eventually be able to write:

```ts
yield* bridge.sessions.events(id).pipe(
  Stream.runForEach(handleEvent)
)
```

and genuinely not care which coding agent produced the session.

That is Bridge.
