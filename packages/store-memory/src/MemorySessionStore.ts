import { type SessionQuery, SessionStore, type SessionStoreShape } from "@agentbridge/core"
import type { ImportWarning, Session, SessionEvent, SessionId } from "@agentbridge/schema"
import { Effect, Layer, Option, Ref, Stream } from "effect"

interface Entry {
  readonly session: Session
  readonly warnings: ReadonlyArray<ImportWarning>
  readonly fingerprint: string | undefined
}

interface State {
  readonly sessions: ReadonlyMap<SessionId, Entry>
  readonly events: ReadonlyMap<SessionId, ReadonlyArray<SessionEvent>>
}

const compareSessions = (a: Session, b: Session) =>
  (a.startedAt === undefined ? (b.startedAt === undefined ? 0 : 1)
    : b.startedAt === undefined ? -1 : Date.parse(b.startedAt) - Date.parse(a.startedAt)) || a.id.localeCompare(b.id)

export const make: Effect.Effect<SessionStoreShape> = Effect.gen(function*() {
  const state = yield* Ref.make<State>({ sessions: new Map(), events: new Map() })

  const store: SessionStoreShape = {
    putSession: (session, warnings = [], fingerprint) =>
      Ref.update(state, (s) => ({ ...s, sessions: new Map(s.sessions).set(session.id, { session, warnings, fingerprint }) })),

    getFingerprint: (id) => Ref.get(state).pipe(Effect.map((s) => Option.fromNullishOr(s.sessions.get(id)?.fingerprint))),

    putEvents: (sessionId, events) =>
      Ref.update(state, (s) => ({
        ...s,
        events: new Map(s.events).set(sessionId, [...events].sort((a, b) => a.sequence - b.sequence))
      })),

    getSession: (id) => Ref.get(state).pipe(Effect.map((s) => Option.fromNullishOr(s.sessions.get(id)?.session))),

    getWarnings: (id) => Ref.get(state).pipe(Effect.map((s) => s.sessions.get(id)?.warnings ?? [])),

    events: (id) =>
      Stream.unwrap(Ref.get(state).pipe(Effect.map((s) => Stream.fromIterable(s.events.get(id) ?? [])))),

    query: (query: SessionQuery) =>
      Stream.unwrap(
        Ref.get(state).pipe(
          Effect.map((s) => {
            const matches = [...s.sessions.values()]
              .map((entry) => entry.session)
              .filter((session) =>
                (query.harness === undefined || session.harness.id === query.harness) &&
                (query.projectPath === undefined || session.projectPath === query.projectPath) &&
                (query.startedAfter === undefined ||
                  (session.startedAt !== undefined && Date.parse(session.startedAt) > Date.parse(query.startedAfter)))
              )
              .sort(compareSessions)
            return Stream.fromIterable(query.limit === undefined ? matches : matches.slice(0, query.limit))
          })
        )
      )
  }
  return store
})

export const MemorySessionStore = {
  make,
  layer: Layer.effect(SessionStore, make)
}
