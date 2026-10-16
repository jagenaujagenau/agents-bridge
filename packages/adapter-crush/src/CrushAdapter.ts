import {
  commonBinDirs,
  describeCause,
  detectHarness,
  type Emission,
  type HarnessAdapterShape,
  HostEnvironment,
  isWithinProject,
  type ListSessionsOptions,
  parseJson,
  SessionNotFound,
  SessionReadError,
  SqliteReader,
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
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { FORMAT, HARNESS, initialState, NAME, normalizeMessage } from "./CrushNormalizer.ts"
import { type MessageRow, ProjectRegistry, type SessionRow } from "./schema/CrushRecord.ts"

const harness = HARNESS as HarnessId

export const CrushCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  // Crush keeps per-session token totals only (sessions.prompt_tokens / completion_tokens),
  // not usage per model call; the totals go to session metadata.
  tokenUsage: false,
  subagents: true
}

/** One Crush database and the project it belongs to, when known. */
export interface CrushDatabase {
  readonly database: string
  readonly projectPath: string | undefined
}

/**
 * Where Crush keeps global data (`GlobalConfigData` in internal/config/load.go):
 * `CRUSH_GLOBAL_DATA`, else `$XDG_DATA_HOME/crush`, else `%LOCALAPPDATA%\crush`, else
 * `~/.local/share/crush`. It holds `projects.json` (read) and `crush.json` (provider
 * configuration and API keys; never read).
 */
export const crushGlobalDataDir = Effect.gen(function*() {
  const host = yield* HostEnvironment
  const path = yield* Path.Path
  const explicit = yield* host.variable("CRUSH_GLOBAL_DATA")
  if (explicit) return explicit
  const xdg = yield* host.variable("XDG_DATA_HOME")
  if (xdg) return path.join(xdg, "crush")
  const localAppData = yield* host.variable("LOCALAPPDATA")
  if (localAppData) return path.join(localAppData, "crush")
  return path.join(host.home ?? ".", ".local", "share", "crush")
})

const SESSION_COLUMNS = "id, parent_session_id, title, prompt_tokens, completion_tokens, cost, created_at, updated_at"

/** Crush's own placeholder titles; the first prompt is a better name. */
const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set(["New Session", "New Agent Session", "Fetch Analysis"])

const iso = (seconds: number | null) =>
  typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined

const decodeRegistry = Schema.decodeUnknownOption(ProjectRegistry)

/** `bridge` takes several entries in one variable, like PATH. */
const splitList = (path: Path.Path, value: string | undefined) =>
  (value ?? "").split(path.sep === "\\" ? ";" : ":").map((entry) => entry.trim()).filter((entry) => entry.length > 0)

export class CrushAdapter extends Context.Service<CrushAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-crush/CrushAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sqlite = yield* SqliteReader
    const host = yield* HostEnvironment
    const detectContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | HostEnvironment | VersionProbe>()
    const globalDir = yield* crushGlobalDataDir
    const registryPath = path.join(globalDir, "projects.json")
    const explicitRoots = splitList(path, yield* host.variable("BRIDGE_CRUSH_PROJECTS"))

    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))

    /** The project a data directory belongs to: `<project>/.crush` → `<project>`. */
    const projectOfDataDir = (dataDir: string) => (path.basename(dataDir) === ".crush" ? path.dirname(dataDir) : undefined)

    /**
     * Every Crush database Bridge knows about, deduplicated, existing files only:
     *
     * 1. each project in Crush's registry (`projects.json`), at `<data_dir>/crush.db`;
     * 2. the server workspace database, `<global data>/.crush/crush.db`;
     * 3. each entry of `BRIDGE_CRUSH_PROJECTS` (a project directory, a data directory or a
     *    `crush.db` file), for projects Crush never registered.
     *
     * Nothing else is searched: Crush keeps one database per project, and Bridge does not
     * crawl the home directory for them.
     */
    const databases: Effect.Effect<ReadonlyArray<CrushDatabase>> = Effect.gen(function*() {
      const candidates: Array<CrushDatabase> = []
      const registry = yield* fs.readFileString(registryPath).pipe(
        Effect.map((text) => Option.getOrUndefined(Option.flatMap(parseJson(text), decodeRegistry))),
        Effect.orElseSucceed(() => undefined)
      )
      // Several working directories can share one data directory (a monorepo's packages
      // find the root's `.crush`). One registered directory is the project; several mean the
      // data directory's parent is.
      const registered = new Map<string, Set<string>>()
      for (const project of registry?.projects ?? []) {
        if (!project.data_dir) continue
        // Crush always writes absolute paths; a relative one resolves against the registry's directory.
        const dataDir = path.resolve(globalDir, project.data_dir)
        const paths = registered.get(dataDir) ?? new Set<string>()
        if (project.path) paths.add(project.path)
        registered.set(dataDir, paths)
      }
      for (const [dataDir, paths] of registered) {
        const [only] = paths
        const projectPath = paths.size === 1 ? only : projectOfDataDir(dataDir) ?? only
        candidates.push({ database: path.join(dataDir, "crush.db"), projectPath })
      }
      candidates.push({ database: path.join(globalDir, ".crush", "crush.db"), projectPath: undefined })
      for (const root of explicitRoots) {
        const entry = path.resolve(root)
        if (entry.endsWith(".db")) {
          candidates.push({ database: entry, projectPath: projectOfDataDir(path.dirname(entry)) })
        } else if (yield* exists(path.join(entry, "crush.db"))) {
          candidates.push({ database: path.join(entry, "crush.db"), projectPath: projectOfDataDir(entry) })
        } else {
          candidates.push({ database: path.join(entry, ".crush", "crush.db"), projectPath: entry })
        }
      }
      const seen = new Set<string>()
      const found: Array<CrushDatabase> = []
      for (const candidate of candidates) {
        const key = path.normalize(candidate.database)
        if (seen.has(key)) continue
        seen.add(key)
        if (yield* exists(candidate.database)) found.push({ ...candidate, database: key })
      }
      return found
    })

    const readError = (database: string) => (error: unknown) =>
      new SessionReadError({ harness, path: database, message: describeCause(error) })

    const sessionRows = (database: string, sql: string, params: ReadonlyArray<string | number>) =>
      sqlite.rows(database, sql, params).pipe(
        Stream.map((row) => row as unknown as SessionRow),
        Stream.mapError(readError(database))
      )

    const toDescriptor = (db: CrushDatabase) => (row: SessionRow): SessionDescriptor => {
      const startedAt = iso(row.created_at)
      const updatedAt = iso(row.updated_at)
      // Agent tool sessions are `<assistant message ID>$$<tool call ID>`.
      const agentLabel = row.parent_session_id && row.id.includes("$$")
        ? (row.title === "Fetch Analysis" ? "agentic_fetch" : "agent")
        : undefined
      return {
        id: makeSessionId(HARNESS, row.id),
        harness,
        nativeId: row.id,
        sourcePath: db.database,
        ...(db.projectPath !== undefined ? { projectPath: db.projectPath } : {}),
        ...(row.parent_session_id ? { parentSessionId: makeSessionId(HARNESS, row.parent_session_id) } : {}),
        ...(agentLabel !== undefined ? { agentLabel } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {})
      }
    }

    const listSessions = (options?: ListSessionsOptions) =>
      Stream.unwrap(Effect.map(databases, Stream.fromIterable)).pipe(
        Stream.filter((db) =>
          options?.projectPath === undefined || db.projectPath === undefined ||
          isWithinProject(path, db.projectPath, options.projectPath)
        ),
        Stream.flatMap((db) =>
          sessionRows(
            db.database,
            // `title-<id>` sessions are title generation calls from older Crush versions, not agent work.
            `select ${SESSION_COLUMNS} from sessions
              where updated_at >= ? and id not like 'title-%'
              order by updated_at desc`,
            [Math.floor((options?.since?.getTime() ?? 0) / 1000)]
          ).pipe(Stream.map(toDescriptor(db)))
        ),
        Stream.filter((d) => options?.projectPath === undefined || isWithinProject(path, d.projectPath, options.projectPath))
      )

    const findSession = (nativeId: string) =>
      Effect.gen(function*() {
        for (const db of yield* databases) {
          const rows = yield* Stream.runCollect(
            sessionRows(db.database, `select ${SESSION_COLUMNS} from sessions where id = ?`, [nativeId])
          )
          const row = rows[0]
          if (row !== undefined) return { db, row }
        }
        return undefined
      })

    const resolve = (id: SessionId) =>
      Effect.gen(function*() {
        const parsed = parseSessionId(id)
        if (parsed === undefined || parsed.harness !== harness) return yield* new SessionNotFound({ sessionId: id })
        const found = yield* findSession(parsed.nativeId)
        return found === undefined ? yield* new SessionNotFound({ sessionId: id }) : toDescriptor(found.db)(found.row)
      })

    const sessionMetadata = (descriptor: SessionDescriptor): Stream.Stream<Emission, SessionReadError> =>
      sessionRows(descriptor.sourcePath, `select ${SESSION_COLUMNS} from sessions where id = ?`, [descriptor.nativeId]).pipe(
        Stream.map((row): Emission => {
          const totals = {
            ...(row.prompt_tokens ? { promptTokens: row.prompt_tokens } : {}),
            ...(row.completion_tokens ? { completionTokens: row.completion_tokens } : {}),
            ...(row.cost ? { cost: row.cost } : {})
          }
          return {
            _tag: "Metadata",
            patch: {
              ...(row.title ? { title: { value: row.title, priority: PLACEHOLDER_TITLES.has(row.title) ? 5 : 30 } } : {}),
              // Session totals (a parent's include its agent sessions'), not per-call usage.
              ...(Object.keys(totals).length > 0 ? { metadata: { sessionTotals: totals } } : {})
            }
          }
        })
      )

    /** Columns added by later migrations; older databases lack them. */
    const messageColumns = (database: string) =>
      Stream.runCollect(
        sqlite.rows(database, "select name from pragma_table_info('messages')").pipe(Stream.mapError(readError(database)))
      ).pipe(
        Effect.map((rows) => {
          const names = new Set(rows.map((row) => row["name"]))
          return [
            "id, role, parts, model, created_at",
            names.has("provider") ? "provider" : "null as provider",
            names.has("is_summary_message") ? "is_summary_message" : "0 as is_summary_message"
          ].join(", ")
        })
      )

    const read = (descriptor: SessionDescriptor) =>
      Stream.concat(
        sessionMetadata(descriptor),
        Stream.unwrap(
          Effect.map(messageColumns(descriptor.sourcePath), (columns) =>
            sqlite.rows(
              descriptor.sourcePath,
              // Messages share one-second timestamps; insertion order (rowid) breaks ties as Crush writes them.
              `select ${columns} from messages where session_id = ? order by created_at, rowid`,
              [descriptor.nativeId]
            ))
        ).pipe(
          Stream.mapError(readError(descriptor.sourcePath)),
          Stream.map((row) => row as unknown as MessageRow),
          Stream.zipWithIndex,
          Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath, descriptor.projectPath), normalizeMessage)
        )
      ).pipe(Stream.withSpan("bridge.normalize-session", { attributes: { harness, format: FORMAT } }))

    const adapter: HarnessAdapterShape = {
      id: harness,
      name: NAME,
      capabilities: CrushCapabilities,
      detect: Effect.flatMap(databases, (dbs) =>
        detectHarness({
          harness,
          name: NAME,
          executables: ["crush"],
          extraDirs: [
            ...(host.home ? [path.join(host.home, "go", "bin")] : []),
            ...commonBinDirs(path, host.home)
          ],
          historyPaths: dbs.map((db) => db.database)
        })).pipe(Effect.provideContext(detectContext)),
      listSessions,
      resolve,
      read
    }
    return adapter
  })

  /** Requires `SqliteReader`, `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(CrushAdapter, CrushAdapter.make)
}
