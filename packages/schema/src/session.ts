import { Schema } from "effect"
import { HarnessId, SessionId, Timestamp } from "./ids.ts"

export const SessionStatus = Schema.Literals(["running", "completed", "failed", "cancelled", "unknown"])
export type SessionStatus = typeof SessionStatus.Type

export const HarnessIdentity = Schema.Struct({
  id: HarnessId,
  name: Schema.String,
  version: Schema.optionalKey(Schema.String)
}).pipe(Schema.annotate({ identifier: "HarnessIdentity" }))
export type HarnessIdentity = typeof HarnessIdentity.Type

export const SessionCapabilities = Schema.Struct({
  history: Schema.Boolean,
  live: Schema.Boolean,
  resume: Schema.Boolean,
  toolCalls: Schema.Boolean,
  /** Tool outcomes are recorded; see HarnessCapabilities.toolResults. */
  toolResults: Schema.Boolean,
  reasoning: Schema.Boolean,
  tokenUsage: Schema.Boolean,
  fileEvents: Schema.Boolean,
  commandEvents: Schema.Boolean
}).pipe(Schema.annotate({ identifier: "SessionCapabilities" }))
export type SessionCapabilities = typeof SessionCapabilities.Type

export const SessionRelationshipType = Schema.Literals(["parent", "child", "resume", "fork", "delegate", "related"])
export type SessionRelationshipType = typeof SessionRelationshipType.Type

/**
 * A directed link: `from` has relationship `type` to `to`.
 * `fork`: from was forked from to. `resume`: from continues to.
 */
export const SessionRelationship = Schema.Struct({
  type: SessionRelationshipType,
  from: SessionId,
  to: SessionId
}).pipe(Schema.annotate({ identifier: "SessionRelationship" }))
export type SessionRelationship = typeof SessionRelationship.Type

export const Session = Schema.Struct({
  id: SessionId,
  harness: HarnessIdentity,
  /**
   * Historical sources never record an explicit end, so imported history is
   * `unknown` unless the source proves otherwise.
   */
  status: SessionStatus,
  title: Schema.optionalKey(Schema.String),
  projectPath: Schema.optionalKey(Schema.String),
  workspacePath: Schema.optionalKey(Schema.String),
  parentSessionId: Schema.optionalKey(SessionId),
  /** Human-readable label for agent sessions spawned by another session. */
  agentLabel: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Timestamp),
  endedAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
  /** Links to other sessions beyond the parent (forks, resumptions). */
  relationships: Schema.optionalKey(Schema.Array(SessionRelationship)),
  capabilities: SessionCapabilities,
  metadata: Schema.Record(Schema.String, Schema.Json)
}).pipe(Schema.annotate({ identifier: "Session", title: "Bridge Session" }))
export type Session = typeof Session.Type

/**
 * Cheap listing entry. Built from file metadata plus at most a small head read;
 * never from a full parse.
 */
export const SessionDescriptor = Schema.Struct({
  id: SessionId,
  harness: HarnessId,
  nativeId: Schema.String,
  /** File or database holding the session. Several sessions may share one database. */
  sourcePath: Schema.String,
  /** Size of the session's own file; absent when the session lives in a shared database. */
  sizeBytes: Schema.optionalKey(Schema.Int),
  projectPath: Schema.optionalKey(Schema.String),
  parentSessionId: Schema.optionalKey(SessionId),
  agentLabel: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp)
}).pipe(Schema.annotate({ identifier: "SessionDescriptor" }))
export type SessionDescriptor = typeof SessionDescriptor.Type

