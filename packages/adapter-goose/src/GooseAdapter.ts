import {
  commonBinDirs,
  describeCause,
  detectHarness,
  Emission,
  type HarnessAdapterShape,
  HostEnvironment,
  isWithinProject,
  type ListSessionsOptions,
  parseJson,
  readHeadLines,
  readLines,
  SessionNotFound,
  SessionReadError,
  SqliteReader,
  stringProp,
  VersionProbe
} from "@agentbridge/core"
import {
  type HarnessId,
  makeSessionId,
  noCapabilities,
  parseSessionId,
  type SessionDescriptor,
  type SessionId
} from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import {
  decodeLegacyLine,
  decodeRow,
  FORMAT,
  HARNESS,
  initialState,
  LEGACY_FORMAT,
  messageTime,
  NAME,
  normalize
} from "./GooseNormalizer.ts"
import type { MessageRow, SessionRow } from "./schema/GooseRecord.ts"

const harness = HARNESS as HarnessId

export const GooseCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  // Per model call, from `metadata.usage` on the call's last assistant message (Goose 1.3x+).
  tokenUsage: true,
  subagents: true
}

/** Columns read from `sessions`; any missing from an older schema is selected as NULL. */
const SESSION_COLUMNS = [
  "id",
  "name",
  "description",
  "session_type",
  "working_dir",
  "created_at",
  "updated_at",
  "parent_session_id",
  "provider_name"
] as const
const MESSAGE_COLUMNS = ["id", "message_id", "role", "content_json", "created_timestamp", "metadata_json"] as const

const selectList = (wanted: ReadonlyArray<string>, present: ReadonlySet<string>) =>
  wanted.map((column) => (present.has(column) ? column : `null as ${column}`)).join(", ")

/**
 * `sessions.created_at` / `updated_at` are SQLite `CURRENT_TIMESTAMP` text (`YYYY-MM-DD HH:MM:SS`,
 * UTC) or, for imported sessions, RFC 3339. Never interpreted as local time.
 */
export const sqliteTime = (value: string | number | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined
  if (typeof value === "number") return messageTime(value)
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value.trim())
  const millis = Date.parse(naive !== null ? `${naive[1]}T${naive[2]}Z` : value)
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString()
}

/** Legacy session files are named after the session: `<data>/sessions/<id>.jsonl`. */
const legacyStem = (file: string) =>
  file.endsWith(".jsonl") && !file.includes("/") && !file.includes("\\") ? file.slice(0, -".jsonl".length) : undefined

export class GooseAdapter extends Context.Service<GooseAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-goose/GooseAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sqlite = yield* SqliteReader
    const host = yield* HostEnvironment
    const detectContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | HostEnvironment | VersionProbe>()

    // Goose's `Paths::data_dir()`: `$GOOSE_PATH_ROOT/data` when absolute, else the XDG data dir
    // (etcetera's XDG strategy, also on macOS): `$XDG_DATA_HOME/goose` or `~/.local/share/goose`.
    const pathRoot = yield* host.variable("GOOSE_PATH_ROOT")
    const xdgData = yield* host.variable("XDG_DATA_HOME")
    const dataDir = pathRoot !== undefined && path.isAbsolute(pathRoot)
      ? path.join(pathRoot, "data")
      : xdgData !== undefined && path.isAbsolute(xdgData)
      ? path.join(xdgData, "goose")
      : path.join(host.home ?? ".", ".local", "share", "goose")
    const sessionsDir = path.join(dataDir, "sessions")
    const database = path.join(sessionsDir, "sessions.db")

    const dbError = (error: unknown) => new SessionReadError({ harness, path: database, message: describeCause(error) })
    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))

    const rows = <A>(sql: string, params: ReadonlyArray<string | number> = []) =>
      sqlite.rows(database, sql, params).pipe(Stream.map((row) => row as unknown as A), Stream.mapError(dbError))

    /** Column names of a table, so older schema versions read without errors. */
    const columnsOf = (table: "sessions" | "messages") =>
      Stream.runCollect(rows<{ name: string }>(`select name from pragma_table_info('${table}')`)).pipe(
        Effect.map((found) => new Set(found.map((c) => c.name)))
      )

    const sessionRows = (where: string, params: ReadonlyArray<string | number>) =>
      Stream.unwrap(Effect.gen(function*() {
        if (!(yield* exists(database))) return Stream.empty
        const present = yield* columnsOf("sessions")
        if (!present.has("id")) return Stream.empty
        return rows<SessionRow>(`select ${selectList(SESSION_COLUMNS, present)} from sessions ${where}`, params)
      }))

    const toDescriptor = (row: SessionRow): SessionDescriptor => {
      const startedAt = sqliteTime(row.created_at)
      const updatedAt = sqliteTime(row.updated_at)
      return {
        id: makeSessionId(HARNESS, row.id),
        harness,
        nativeId: row.id,
        sourcePath: database,
        ...(row.working_dir ? { projectPath: row.working_dir } : {}),
        ...(row.parent_session_id ? { parentSessionId: makeSessionId(HARNESS, row.parent_session_id) } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {})
      }
    }

    // ------------------------------------------------------------------ legacy JSONL (Goose < 1.10)

    const legacyDescriptor = (nativeId: string, file: string) =>
      Effect.gen(function*() {
        const info = yield* fs.stat(file).pipe(Effect.mapError((cause) => new SessionReadError({ harness, path: file, message: describeCause(cause) })))
        const head = yield* readHeadLines(fs, harness, file, 2)
        const header = Option.getOrUndefined(parseJson(head[0] ?? ""))
        const first = Option.getOrUndefined(parseJson(head[1] ?? ""))
        const created = (first as { created?: unknown } | undefined)?.created
        const startedAt = sqliteTime(stringProp(header, "created_at")) ??
          (typeof created === "number" ? messageTime(created) : undefined)
        const updatedAt = Option.getOrUndefined(Option.map(info.mtime, (d) => d.toISOString()))
        const projectPath = stringProp(header, "working_dir")
        const descriptor: SessionDescriptor = {
          id: makeSessionId(HARNESS, nativeId),
          harness,
          nativeId,
          sourcePath: file,
          sizeBytes: Number(info.size),
          ...(projectPath ? { projectPath } : {}),
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {})
        }
        return descriptor
      })

    /** Legacy files Goose has not imported. Goose imports them into the database on first start, then keeps them. */
    const legacySessions = (skip: ReadonlySet<string>) =>
      Stream.unwrap(Effect.gen(function*() {
        if (!(yield* exists(sessionsDir))) return Stream.empty
        const entries = yield* fs.readDirectory(sessionsDir).pipe(
          Effect.mapError((cause) => new SessionReadError({ harness, path: sessionsDir, message: describeCause(cause) }))
        )
        const stems = entries.flatMap((entry) => {
          const stem = legacyStem(entry)
          return stem !== undefined && stem.length > 0 && !skip.has(stem) ? [stem] : []
        }).sort()
        return Stream.fromIterable(stems).pipe(
          Stream.mapEffect((stem) => legacyDescriptor(stem, path.join(sessionsDir, `${stem}.jsonl`)))
        )
      }))

    // ------------------------------------------------------------------ listing

    const listSessions = (options?: ListSessionsOptions) =>
      Stream.unwrap(Effect.gen(function*() {
        const hasDb = yield* exists(database)
        const present = hasDb ? yield* columnsOf("sessions") : new Set<string>()
        // Internal one-shot sessions (naming, tool labels, code-mode helpers) are `hidden`.
        const where = present.has("session_type") ? "where session_type != 'hidden'" : ""
        const order = present.has("updated_at") ? "order by updated_at desc" : ""
        const dbIds = hasDb
          ? new Set((yield* Stream.runCollect(rows<{ id: string }>("select id from sessions"))).map((r) => r.id))
          : new Set<string>()
        const since = options?.since?.getTime()
        return Stream.concat(sessionRows(`${where} ${order}`, []).pipe(Stream.map(toDescriptor)), legacySessions(dbIds)).pipe(
          Stream.filter((d) =>
            (since === undefined || d.updatedAt === undefined || Date.parse(d.updatedAt) >= since) &&
            (options?.projectPath === undefined || isWithinProject(path, d.projectPath, options.projectPath))
          )
        )
      }))

    const resolve = (id: SessionId) =>
      Effect.gen(function*() {
        const parsed = parseSessionId(id)
        if (parsed === undefined || parsed.harness !== harness) return yield* new SessionNotFound({ sessionId: id })
        const found = yield* Stream.runCollect(sessionRows("where id = ?", [parsed.nativeId]))
        if (found[0] !== undefined) return toDescriptor(found[0])
        const stem = legacyStem(`${parsed.nativeId}.jsonl`)
        const file = path.join(sessionsDir, `${parsed.nativeId}.jsonl`)
        if (stem === undefined || stem.startsWith(".") || !(yield* exists(file))) return yield* new SessionNotFound({ sessionId: id })
        return yield* legacyDescriptor(parsed.nativeId, file)
      })

    // ------------------------------------------------------------------ reading

    const sessionMetadata = (descriptor: SessionDescriptor) =>
      sessionRows("where id = ?", [descriptor.nativeId]).pipe(
        Stream.map((row) => {
          const title = row.name?.trim() || row.description?.trim()
          return Emission.metadata({
            ...(title ? { title: { value: title, priority: 30 } } : {}),
            metadata: {
              ...(row.provider_name ? { provider: row.provider_name } : {}),
              ...(row.session_type ? { sessionType: row.session_type } : {})
            }
          })
        })
      )

    const readDatabase = (descriptor: SessionDescriptor) =>
      Stream.concat(
        sessionMetadata(descriptor),
        Stream.unwrap(Effect.gen(function*() {
          const present = yield* columnsOf("messages")
          const order = present.has("created_timestamp") ? "order by created_timestamp, id" : "order by id"
          return rows<MessageRow>(
            `select ${selectList(MESSAGE_COLUMNS, present)} from messages where session_id = ? ${order}`,
            [descriptor.nativeId]
          )
        })).pipe(
          Stream.zipWithIndex,
          Stream.map(([row, ordinal]) => decodeRow(row, ordinal)),
          Stream.mapAccum(() => initialState(descriptor.id, database, FORMAT, descriptor.projectPath), normalize)
        )
      )

    const readLegacy = (descriptor: SessionDescriptor) =>
      readLines(fs, harness, descriptor.sourcePath).pipe(
        Stream.map(decodeLegacyLine),
        Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath, LEGACY_FORMAT, descriptor.projectPath), normalize)
      )

    const read = (descriptor: SessionDescriptor) =>
      (descriptor.sourcePath === database ? readDatabase(descriptor) : readLegacy(descriptor)).pipe(
        Stream.withSpan("bridge.normalize-session", { attributes: { harness, format: descriptor.sourcePath === database ? FORMAT : LEGACY_FORMAT } })
      )

    const adapter: HarnessAdapterShape = {
      id: harness,
      name: NAME,
      capabilities: GooseCapabilities,
      detect: detectHarness({
        harness,
        name: NAME,
        executables: ["goose"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: [database, sessionsDir]
      }).pipe(Effect.provideContext(detectContext)),
      listSessions,
      resolve,
      read
    }
    return adapter
  })

  /** Requires `SqliteReader`, `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(GooseAdapter, GooseAdapter.make)
}
