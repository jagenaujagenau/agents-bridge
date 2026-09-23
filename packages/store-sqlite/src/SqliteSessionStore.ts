import { describeCause, type SessionQuery, SessionStore, type SessionStoreShape, StoreError } from "@agentbridge/core"
import {
  encodeEvent,
  type ImportWarning,
  Session,
  type SessionEvent,
  type SessionId,
  validateEvent,
  validateSession
} from "@agentbridge/schema"
import { Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * Reference persistent store (spec §38) on Node's built-in `node:sqlite`.
 * Canonical JSON is stored as-is; only commonly queried fields get columns.
 * The database is opened on first use, so constructing the layer never touches disk.
 */

const SCHEMA_VERSION = 1

const DDL = `
create table if not exists sessions (
  id text primary key,
  harness_id text not null,
  status text not null,
  title text,
  project_path text,
  started_at text,
  started_at_ms integer,
  ended_at text,
  fingerprint text,
  encoded_json text not null,
  warnings_json text not null
);
create table if not exists events (
  id text not null,
  session_id text not null,
  sequence integer not null,
  type text not null,
  timestamp text,
  encoded_json text not null,
  primary key (session_id, sequence)
);
create index if not exists sessions_harness on sessions(harness_id);
create index if not exists sessions_project on sessions(project_path);
create index if not exists sessions_started on sessions(started_at_ms);
`

const PAGE = 1000

const encodeSession = Schema.encodeSync(Session)

const attempt = <A>(operation: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new StoreError({ operation, message: describeCause(cause) }) })

const open = (file: string) =>
  Effect.acquireRelease(
    attempt("open", () => {
      if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
      const db = new DatabaseSync(file)
      db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;")
      db.exec(DDL)
      db.exec(`pragma user_version = ${SCHEMA_VERSION}`)
      return {
        db,
        upsertSession: db.prepare(`
          insert into sessions (id, harness_id, status, title, project_path, started_at, started_at_ms, ended_at, fingerprint, encoded_json, warnings_json)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set harness_id = excluded.harness_id, status = excluded.status, title = excluded.title,
            project_path = excluded.project_path, started_at = excluded.started_at, started_at_ms = excluded.started_at_ms,
            ended_at = excluded.ended_at, fingerprint = excluded.fingerprint, encoded_json = excluded.encoded_json,
            warnings_json = excluded.warnings_json`),
        insertEvent: db.prepare(
          "insert into events (id, session_id, sequence, type, timestamp, encoded_json) values (?, ?, ?, ?, ?, ?)"
        ),
        deleteEvents: db.prepare("delete from events where session_id = ?"),
        selectSession: db.prepare("select encoded_json, warnings_json, fingerprint from sessions where id = ?"),
        // Keyset pagination, so memory per page stays bounded however long the session is.
        selectEvents: db.prepare(
          "select encoded_json from events where session_id = ? and sequence >= ? order by sequence limit ?"
        )
      }
    }),
    ({ db }) => Effect.sync(() => db.close())
  )

type Connection = Effect.Success<ReturnType<typeof open>>

export const make = (file: string): Effect.Effect<SessionStoreShape, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const connect = yield* Effect.cached(Scope.provide(scope)(open(file)))
    const withDb = <A>(operation: string, run: (c: Connection) => A) =>
      Effect.flatMap(connect, (c) => attempt(operation, () => run(c)))

    const row = (id: SessionId) =>
      withDb("getSession", (c) =>
        c.selectSession.get(id) as { encoded_json: string; warnings_json: string; fingerprint: string | null } | undefined
      )

    const store: SessionStoreShape = {
      putSession: (session, warnings = [], fingerprint) =>
        withDb("putSession", (c) => {
          c.upsertSession.run(
            session.id,
            session.harness.id,
            session.status,
            session.title ?? null,
            session.projectPath ?? null,
            session.startedAt ?? null,
            session.startedAt === undefined ? null : Date.parse(session.startedAt),
            session.endedAt ?? null,
            fingerprint ?? null,
            JSON.stringify(encodeSession(session)),
            JSON.stringify(warnings)
          )
        }),

      getFingerprint: (id) => Effect.map(row(id), (r) => Option.fromNullishOr(r?.fingerprint)),

      putEvents: (sessionId, events) =>
        withDb("putEvents", (c) => {
          c.db.exec("begin")
          try {
            c.deleteEvents.run(sessionId)
            for (const event of events) {
              c.insertEvent.run(
                event.id,
                sessionId,
                event.sequence,
                event.type,
                event.timestamp ?? null,
                JSON.stringify(encodeEvent(event))
              )
            }
            c.db.exec("commit")
          } catch (error) {
            c.db.exec("rollback")
            throw error
          }
        }),

      getSession: (id) =>
        Effect.flatMap(row(id), (r) =>
          r === undefined
            ? Effect.succeed(Option.none<Session>())
            : attempt("getSession", () => Option.some(validateSession(JSON.parse(r.encoded_json))))),

      getWarnings: (id) =>
        Effect.flatMap(row(id), (r) =>
          attempt("getWarnings", () => (r === undefined ? [] : JSON.parse(r.warnings_json) as ReadonlyArray<ImportWarning>))),

      events: (id) =>
        Stream.paginate(0, (from: number) =>
          withDb("events", (c) => {
            const rows = c.selectEvents.all(id, from, PAGE) as Array<{ encoded_json: string }>
            const events = rows.map((r) => validateEvent(JSON.parse(r.encoded_json)) as SessionEvent)
            const last = events.at(-1)
            return [events, rows.length === PAGE && last !== undefined ? Option.some(last.sequence + 1) : Option.none<number>()] as const
          })),

      query: (query: SessionQuery) =>
        Stream.unwrap(withDb("query", (c) => {
          const where: Array<string> = []
          const params: Array<string | number> = []
          if (query.harness !== undefined) {
            where.push("harness_id = ?")
            params.push(query.harness)
          }
          if (query.projectPath !== undefined) {
            where.push("project_path = ?")
            params.push(query.projectPath)
          }
          if (query.startedAfter !== undefined) {
            where.push("started_at_ms > ?")
            params.push(Date.parse(query.startedAfter))
          }
          if (query.limit !== undefined) params.push(query.limit)
          const sql = `select encoded_json from sessions ${where.length ? `where ${where.join(" and ")}` : ""}
            order by started_at_ms is null, started_at_ms desc, id asc ${query.limit !== undefined ? "limit ?" : ""}`
          const rows = c.db.prepare(sql).all(...params) as Array<{ encoded_json: string }>
          return Stream.fromIterable(rows.map((r) => validateSession(JSON.parse(r.encoded_json))))
        }))
    }
    return store
  })

export const SqliteSessionStore = {
  make,
  /** A store in the SQLite database at `file` (created on first use). `":memory:"` for an ephemeral one. */
  layer: (file: string) => Layer.effect(SessionStore, make(file))
}
