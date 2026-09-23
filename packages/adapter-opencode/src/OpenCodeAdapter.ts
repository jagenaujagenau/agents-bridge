import {
  commonBinDirs,
  isWithinProject,
  describeCause,
  detectHarness,
  type HarnessAdapterShape,
  harnessRoot,
  HostEnvironment,
  type ListSessionsOptions,
  SessionNotFound,
  SessionReadError,
  SqliteReader,
  type SqliteReadError,
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
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { FORMAT, groupOf, HARNESS, initialState, NAME, normalizeGroup } from "./OpenCodeNormalizer.ts"
import type { PartRow, SessionRow } from "./schema/OpenCodeRecord.ts"

const harness = HARNESS as HarnessId

export const OpenCodeCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  tokenUsage: true,
  subagents: true
}

const SESSION_COLUMNS = "id, parent_id, directory, title, version, agent, time_created, time_updated"

const iso = (millis: number | null) => (typeof millis === "number" ? new Date(millis).toISOString() : undefined)

export class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-opencode/OpenCodeAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sqlite = yield* SqliteReader
    const host = yield* HostEnvironment
    const detectContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | HostEnvironment | VersionProbe>()
    const dataHome = yield* harnessRoot("XDG_DATA_HOME", ".local", "share")
    const override = yield* host.variable("OPENCODE_DATA_DIR")
    const dataDir = override ?? path.join(dataHome, "opencode")
    const database = path.join(dataDir, "opencode.db")

    const readError = (error: SqliteReadError | unknown) =>
      new SessionReadError({ harness, path: database, message: describeCause(error) })

    const available = fs.exists(database).pipe(Effect.orElseSucceed(() => false))

    const toDescriptor = (row: SessionRow): SessionDescriptor => {
      const startedAt = iso(row.time_created)
      const updatedAt = iso(row.time_updated)
      return {
        id: makeSessionId(HARNESS, row.id),
        harness,
        nativeId: row.id,
        sourcePath: database,
        ...(row.directory ? { projectPath: row.directory } : {}),
        ...(row.parent_id ? { parentSessionId: makeSessionId(HARNESS, row.parent_id) } : {}),
        ...(row.parent_id && row.agent ? { agentLabel: row.agent } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {})
      }
    }

    const sessionRows = (sql: string, params: ReadonlyArray<string | number>) =>
      sqlite.rows(database, sql, params).pipe(
        Stream.map((row) => row as unknown as SessionRow),
        Stream.mapError(readError)
      )

    const listSessions = (options?: ListSessionsOptions) =>
      Stream.unwrap(
        Effect.map(available, (exists) => {
          if (!exists) return Stream.empty
          const since = options?.since?.getTime() ?? 0
          return sessionRows(
            `select ${SESSION_COLUMNS} from session where time_updated >= ? order by time_updated desc`,
            [since]
          ).pipe(
            Stream.map(toDescriptor),
            Stream.filter((d) =>
              options?.projectPath === undefined || isWithinProject(path, d.projectPath, options.projectPath)
            )
          )
        })
      )

    const resolve = (id: SessionId) =>
      Effect.gen(function*() {
        const parsed = parseSessionId(id)
        if (parsed === undefined || parsed.harness !== harness || !(yield* available)) {
          return yield* new SessionNotFound({ sessionId: id })
        }
        const rows = yield* Stream.runCollect(
          sessionRows(`select ${SESSION_COLUMNS} from session where id = ?`, [parsed.nativeId])
        )
        const row = rows[0]
        return row === undefined ? yield* new SessionNotFound({ sessionId: id }) : toDescriptor(row)
      })

    const read = (descriptor: SessionDescriptor) =>
      Stream.concat(
        Stream.fromEffect(
          Stream.runCollect(
            sessionRows(`select ${SESSION_COLUMNS} from session where id = ?`, [descriptor.nativeId])
          ).pipe(
            Effect.map((rows) =>
              rows.flatMap((row) => [
                {
                  _tag: "Metadata" as const,
                  patch: {
                    ...(row.title ? { title: { value: row.title, priority: 30 } } : {}),
                    ...(row.version ? { harnessVersion: row.version } : {}),
                    ...(row.agent ? { metadata: { agent: row.agent } } : {})
                  }
                }
              ])
            )
          )
        ).pipe(Stream.flatMap(Stream.fromIterable)),
        sqlite.rows(
          database,
          `select m.id as message_id, m.data as message_data, p.id as part_id, p.data as part_data
             from message m left join part p on p.message_id = m.id
            where m.session_id = ?
            order by m.time_created, m.id, p.id`,
          [descriptor.nativeId]
        ).pipe(
          Stream.mapError(readError),
          Stream.map((row) => row as unknown as PartRow),
          Stream.groupAdjacentBy((row) => row.message_id),
          Stream.zipWithIndex,
          Stream.map(([[, rows], ordinal]) => groupOf(ordinal, rows)),
          Stream.mapAccum(
            () => initialState(descriptor.id, database, descriptor.projectPath),
            normalizeGroup
          )
        )
      ).pipe(Stream.withSpan("bridge.normalize-session", { attributes: { harness, format: FORMAT } }))

    const adapter: HarnessAdapterShape = {
      id: harness,
      name: NAME,
      capabilities: OpenCodeCapabilities,
      detect: detectHarness({
        harness,
        name: NAME,
        executables: ["opencode"],
        extraDirs: [
          ...(host.home ? [path.join(host.home, ".opencode", "bin")] : []),
          ...commonBinDirs(path, host.home)
        ],
        historyPaths: [database]
      }).pipe(Effect.provideContext(detectContext)),
      listSessions,
      resolve,
      read
    }
    return adapter
  })

  /** Requires `SqliteReader`, `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(OpenCodeAdapter, OpenCodeAdapter.make)
}
