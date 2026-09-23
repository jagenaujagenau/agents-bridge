import {
  commonBinDirs,
  type FileCandidate,
  type HarnessAdapterShape,
  harnessRoot,
  HostEnvironment,
  makeFileHistoryAdapter,
  readLines
} from "@agentbridge/core"
import { type HarnessId, noCapabilities } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { decodeLine, HARNESS, initialState, NAME, normalizeLine, parseCursorTimestamp } from "./CursorNormalizer.ts"

const harness = HARNESS as HarnessId

export const CursorCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  toolCalls: true,
  // Cursor transcripts record tool calls but not their results.
  toolResults: false,
  commandEvents: true,
  fileEvents: true,
  subagents: true
}

/**
 * `<project>/agent-transcripts/<id>/<id>.jsonl`, the flat `<project>/agent-transcripts/<id>.jsonl`,
 * and subagents at `<project>/agent-transcripts/<parent>/subagents/<child>.jsonl`.
 */
export const classifyCursorFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  const file = parts[parts.length - 1]
  if (file === undefined || !file.endsWith(".jsonl") || parts[1] !== "agent-transcripts") return undefined
  const stem = file.slice(0, -".jsonl".length)
  if (parts.length === 3) return { path: absolute, nativeId: stem }
  if (parts.length === 4 && parts[2] === stem) return { path: absolute, nativeId: stem }
  if (parts.length === 5 && parts[3] === "subagents") {
    return { path: absolute, nativeId: `${parts[2]}/${stem}`, parentNativeId: parts[2] }
  }
  return undefined
}

/**
 * Cursor names project directories by replacing `/` and `.` in the path with `-`, which is
 * ambiguous with dashes in names. Rebuild the path, only descending into directories that exist.
 */
export const decodeCursorProjectDir = (
  encoded: string,
  exists: (path: string) => Effect.Effect<boolean>
): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    const segments = encoded.split("-").filter((segment) => segment.length > 0)
    if (segments.length === 0) return undefined
    let budget = 1024
    // `directory` is a path known to exist; `component` is the name being assembled below it.
    const search = (index: number, directory: string, component: string): Effect.Effect<string | undefined> =>
      Effect.gen(function*() {
        const candidate = `${directory}/${component}`
        if (index === segments.length) return (yield* exists(candidate)) ? candidate : undefined
        if (--budget < 0) return undefined
        const segment = segments[index]!
        if (yield* exists(candidate)) {
          const found = yield* search(index + 1, candidate, segment)
          if (found !== undefined) return found
        }
        const dashed = yield* search(index + 1, directory, `${component}-${segment}`)
        return dashed ?? (yield* search(index + 1, directory, `${component}.${segment}`))
      })
    return yield* search(1, "", segments[0]!)
  })

export class CursorAdapter extends Context.Service<CursorAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-cursor/CursorAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const cursorDir = yield* harnessRoot("CURSOR_CONFIG_DIR", ".cursor")
    const projectsDir = path.join(cursorDir, "projects")

    const exists = (candidate: string) => fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))

    const decodeProjectDir = (encoded: string) => decodeCursorProjectDir(encoded, exists)

    const projectPaths = new Map<string, string | undefined>()
    const projectPathOf = (projectDirName: string) =>
      projectPaths.has(projectDirName)
        ? Effect.succeed(projectPaths.get(projectDirName))
        : Effect.tap(decodeProjectDir(projectDirName), (decoded) => Effect.sync(() => projectPaths.set(projectDirName, decoded)))

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: CursorCapabilities,
      detect: {
        executables: ["cursor-agent", "cursor"],
        extraDirs: [...commonBinDirs(path, host.home), "/Applications/Cursor.app/Contents/Resources/app/bin"],
        historyPaths: [projectsDir]
      },
      roots: [projectsDir],
      classify: classifyCursorFile,
      headLines: 20,
      inspect: (head) => {
        const timestamp = head.map((line) => /<timestamp>([\s\S]*?)<\/timestamp>/.exec(line)?.[1]).find((t) => t !== undefined)
        const startedAt = timestamp === undefined ? undefined : parseCursorTimestamp(timestamp)
        return startedAt !== undefined ? { startedAt } : {}
      },
      enrich: (candidate) =>
        Effect.map(projectPathOf(path.relative(projectsDir, candidate.path).split(path.sep)[0] ?? ""), (projectPath) =>
          projectPath !== undefined ? { projectPath } : {}),
      follows: true,
      read: (descriptor, readOptions) =>
        readLines(fs, harness, descriptor.sourcePath, { follow: readOptions?.follow }).pipe(
          Stream.map(decodeLine),
          Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath, descriptor.projectPath), normalizeLine)
        )
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(CursorAdapter, CursorAdapter.make)
}
