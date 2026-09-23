import type { HarnessId } from "@agentbridge/schema"
import { type Duration, Effect, FileSystem, Option, Path, Schedule, Stream } from "effect"
import { describeCause, SessionReadError } from "./errors.ts"

/**
 * Filesystem helpers shared by history adapters. They depend only on the
 * Effect platform `FileSystem`/`Path` services, never on `node:fs`.
 */

export interface SourceLine {
  readonly index: number
  readonly line: string
}

/**
 * Stream a JSONL file line by line without loading it whole. Invalid UTF-8
 * becomes U+FFFD, so one bad byte cannot make a session unreadable. Blank
 * lines keep their index so record indices match physical line numbers.
 */
export const readLines = (
  fs: FileSystem.FileSystem,
  harness: HarnessId,
  path: string,
  options?: { readonly bytesToRead?: number | undefined; readonly follow?: Duration.Input | undefined }
) =>
  (options?.follow === undefined
    ? fs.stream(path, { chunkSize: 64 * 1024, bytesToRead: options?.bytesToRead })
    : followBytes(fs, harness, path, options.follow)).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.zipWithIndex,
    Stream.map(([line, index]): SourceLine => ({ index, line })),
    Stream.mapError((cause) => new SessionReadError({ harness, path, message: describeCause(cause) }))
  )

/**
 * The file's bytes, then bytes appended to it, polled every `interval`, until interrupted.
 * Reads continue from the last byte offset, so each poll costs only what was appended; a
 * partial last line stays buffered in `splitLines` until its newline arrives. A file that
 * shrinks was rewritten, not appended to, and fails the stream.
 */
export const followBytes = (fs: FileSystem.FileSystem, harness: HarnessId, path: string, interval: Duration.Input) =>
  Stream.suspend(() => {
    let offset = 0
    const appended = Stream.unwrap(Effect.gen(function*() {
      const size = Number((yield* fs.stat(path)).size)
      if (size < offset) {
        return yield* new SessionReadError({ harness, path, message: "The source shrank; it was rewritten rather than appended to" })
      }
      if (size === offset) return Stream.empty
      const start = offset
      offset = size
      return fs.stream(path, { chunkSize: 64 * 1024, offset: start, bytesToRead: size - start })
    }))
    return appended.pipe(Stream.repeat(Schedule.spaced(interval)))
  })

/** Read only the first `limit` lines of a file. For cheap listing. */
export const readHeadLines = (fs: FileSystem.FileSystem, harness: HarnessId, path: string, limit: number) =>
  fs.stream(path, { chunkSize: 16 * 1024, bytesToRead: 256 * 1024 }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.take(limit),
    Stream.runCollect,
    Effect.mapError((cause) => new SessionReadError({ harness, path, message: describeCause(cause) }))
  )

/** Cache discovery (not file contents or metadata) for five seconds. Errors are never cached. */
export const cacheDiscovery = <A, E, R>(scan: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(scan, "5 seconds")
    const get = cached.pipe(Effect.tapError(() => invalidate))
    return { get, invalidate, refresh: Effect.andThen(invalidate, get) }
  })

/** Directory membership, not a string prefix; preserves source paths unchanged. */
export const isWithinProject = (path: Path.Path, candidate: string | undefined, root: string): boolean => {
  if (candidate === undefined) return false
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Parse JSON without throwing. */
export const parseJson = (text: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(text) as unknown)
  } catch {
    return Option.none()
  }
}

export interface FileInfo {
  readonly path: string
  readonly sizeBytes: number
  readonly modifiedAt: Date | undefined
}

export const statFile = (fs: FileSystem.FileSystem, harness: HarnessId, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info): FileInfo => ({
      path,
      sizeBytes: Number(info.size),
      modifiedAt: Option.getOrUndefined(info.mtime)
    })),
    Effect.mapError((cause) => new SessionReadError({ harness, path, message: describeCause(cause) }))
  )

/** Recursively list files under `root`. A missing root is an empty result, not an error. */
export const listFilesRecursive = (fs: FileSystem.FileSystem, path: Path.Path, harness: HarnessId, root: string) =>
  Effect.gen(function*() {
    const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return [] as ReadonlyArray<string>
    const entries = yield* fs.readDirectory(root, { recursive: true }).pipe(
      Effect.mapError((cause) => new SessionReadError({ harness, path: root, message: describeCause(cause) }))
    )
    return entries.map((entry) => path.join(root, entry)).sort()
  })

/**
 * Look for an executable on PATH plus well-known install directories that GUI
 * launches often miss. Only checks existence; never executes anything.
 */
export const findExecutable = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  name: string,
  options: { readonly pathEnv: string | undefined; readonly extraDirs: ReadonlyArray<string> }
) =>
  Effect.gen(function*() {
    const dirs = [...(options.pathEnv ?? "").split(path.sep === "\\" ? ";" : ":"), ...options.extraDirs].filter((d) => d.length > 0)
    for (const dir of new Set(dirs)) {
      const candidate = path.join(dir, name)
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return Option.some(candidate)
    }
    return Option.none<string>()
  })

export const toIso = (date: Date | undefined): string | undefined =>
  date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString()
