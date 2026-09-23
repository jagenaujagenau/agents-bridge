import { Context, Effect, Layer, Stream } from "effect"
import { Schema } from "effect"

export class SqliteReadError extends Schema.TaggedError<SqliteReadError>()("SqliteReadError", {
  database: Schema.String,
  message: Schema.String
}) {}

export type SqliteValue = string | number | bigint | null | Uint8Array

/**
 * Read-only SQLite access for adapters whose harness stores history in a
 * database. The connection is opened read-only, scoped to the stream, and
 * closed on completion, failure or interruption. Adapters own their SQL;
 * nothing here knows a harness schema.
 */
export interface SqliteReaderShape {
  readonly rows: (
    database: string,
    sql: string,
    params?: ReadonlyArray<SqliteValue>
  ) => Stream.Stream<Readonly<Record<string, SqliteValue>>, SqliteReadError>
}

export class SqliteReader extends Context.Service<SqliteReader, SqliteReaderShape>()(
  "@agentbridge/core/SqliteReader"
) {
  /** For runtimes without SQLite: every query fails. */
  static readonly layerUnavailable = Layer.succeed(SqliteReader, {
    rows: (database) => Stream.fail(new SqliteReadError({ database, message: "SQLite is not available" }))
  })
}

/** Convenience: collect all rows of a small query. */
export const allRows = (
  reader: SqliteReaderShape,
  database: string,
  sql: string,
  params?: ReadonlyArray<SqliteValue>
) => Stream.runCollect(reader.rows(database, sql, params)).pipe(Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, SqliteValue>>>))
