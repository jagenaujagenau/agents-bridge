import type { ImportWarning, Session, SessionEvent, SessionId } from "@agentbridge/schema"
import { Context, type Effect, type Option, type Stream } from "effect"
import type { StoreError } from "./errors.ts"

export interface SessionQuery {
  readonly harness?: string | undefined
  readonly projectPath?: string | undefined
  readonly startedAfter?: string | undefined
  readonly limit?: number | undefined
}

/**
 * Persistence boundary. Storage technology never leaks past this interface;
 * every implementation must pass `@agentbridge/testing`'s store contract suite.
 */
export interface SessionStoreShape {
  /**
   * Insert or replace a session. Replacing is idempotent. `fingerprint` identifies the
   * source state it was imported from, so unchanged sources can be skipped on re-import.
   */
  readonly putSession: (
    session: Session,
    warnings?: ReadonlyArray<ImportWarning>,
    fingerprint?: string
  ) => Effect.Effect<void, StoreError>
  readonly getFingerprint: (id: SessionId) => Effect.Effect<Option.Option<string>, StoreError>
  /** Replace the full ordered event list of a session. */
  readonly putEvents: (sessionId: SessionId, events: ReadonlyArray<SessionEvent>) => Effect.Effect<void, StoreError>
  readonly getSession: (id: SessionId) => Effect.Effect<Option.Option<Session>, StoreError>
  readonly getWarnings: (id: SessionId) => Effect.Effect<ReadonlyArray<ImportWarning>, StoreError>
  /** Events ordered by `sequence`. Empty for unknown sessions. */
  readonly events: (id: SessionId) => Stream.Stream<SessionEvent, StoreError>
  /** Sessions ordered by `startedAt` descending, then ID. */
  readonly query: (query: SessionQuery) => Stream.Stream<Session, StoreError>
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreShape>()(
  "@agentbridge/core/SessionStore"
) {}
