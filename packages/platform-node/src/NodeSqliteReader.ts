import { SqliteReader, SqliteReadError, type SqliteValue } from "@agentbridge/core"
import { Effect, Layer, Stream } from "effect"
import { DatabaseSync } from "node:sqlite"

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * `SqliteReader` over Node's built-in `node:sqlite`: no native build step.
 * Databases are opened read-only, so a harness that is running at the same
 * time is never written to; the connection lives exactly as long as the stream.
 */
export const NodeSqliteReader = Layer.succeed(SqliteReader, {
  rows: (database, sql, params = []) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.try({
          try: () => new DatabaseSync(database, { readOnly: true }),
          catch: (cause) => new SqliteReadError({ database, message: describe(cause) })
        }),
        (db) => Effect.sync(() => db.close())
      ).pipe(
        Effect.flatMap((db) =>
          Effect.try({
            try: () => db.prepare(sql),
            catch: (cause) => new SqliteReadError({ database, message: describe(cause) })
          })
        ),
        Effect.map((statement) =>
          Stream.fromIterable({
            [Symbol.iterator]: () =>
              statement.iterate(...(params as Array<Exclude<SqliteValue, bigint> | bigint>)) as Iterator<
                Readonly<Record<string, SqliteValue>>
              >
          }).pipe(
            Stream.catchCause((cause) =>
              Stream.fail(new SqliteReadError({ database, message: describe(cause) }))
            )
          )
        )
      )
    )
})
