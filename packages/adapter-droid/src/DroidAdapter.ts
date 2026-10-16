import {
  commonBinDirs,
  Emission,
  type FileCandidate,
  type HarnessAdapterShape,
  type HeadFacts,
  HostEnvironment,
  makeFileHistoryAdapter,
  parseJson,
  readLines,
  stringProp
} from "@agentbridge/core"
import { type HarnessId, noCapabilities, type SessionDescriptor } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { decodeLine, HARNESS, initialState, NAME, normalizeLine } from "./DroidNormalizer.ts"
import { SessionSettings } from "./schema/DroidRecord.ts"

const harness = HARNESS as HarnessId

export const DroidCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  // Droid records one context-size number per message, not input/output per model call.
  tokenUsage: false,
  subagents: true
}

/**
 * Map a file under `sessions/` (or the older `projects/`) to a candidate.
 * `<projectKey>/<id>.jsonl`, `btw/<id>.jsonl` and legacy flat `<id>.jsonl` are sessions;
 * `<id>/attachments/**` and `*.settings.json` sidecars are not.
 */
export const classifyDroidFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  const file = parts[parts.length - 1]
  if (file === undefined || !file.endsWith(".jsonl") || parts.length > 2) return undefined
  const stem = file.slice(0, -".jsonl".length)
  if (stem.length === 0 || stem.includes(".")) return undefined
  return { path: absolute, nativeId: stem }
}

/** `session_start` (line 1) gives the project, the caller and the title; the first message gives the start time. */
export const inspectDroidHead = (head: ReadonlyArray<string>): HeadFacts => {
  const records = head.map((line) => Option.getOrUndefined(parseJson(line)))
  const start = records.find((r) => stringProp(r, "type") === "session_start")
  let startedAt: string | undefined
  for (const record of records) {
    const timestamp = (record as { timestamp?: unknown } | undefined)?.timestamp
    if (typeof timestamp === "string") startedAt = timestamp
    else if (typeof timestamp === "number" && Number.isFinite(timestamp)) startedAt = new Date(timestamp).toISOString()
    if (startedAt !== undefined) break
  }
  return {
    projectPath: stringProp(start, "cwd"),
    parentNativeId: stringProp(start, "callingSessionId"),
    startedAt
  }
}

const decodeSettings = Schema.decodeUnknownOption(SessionSettings)

export class DroidAdapter extends Context.Service<DroidAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-droid/DroidAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    // FACTORY_HOME_OVERRIDE replaces the home directory; `.factory` is still appended.
    const home = (yield* host.variable("FACTORY_HOME_OVERRIDE")) ?? host.home ?? "."
    const factoryDir = path.join(home, ".factory")
    const sessionsDir = path.join(factoryDir, "sessions")
    // Older builds (and Droid's hook docs) use `projects/`. Credentials and caches elsewhere in
    // `.factory` (auth.json, config.json, mcp.json, cache/) are never walked.
    const projectsDir = path.join(factoryDir, "projects")

    /** The sibling `<id>.settings.json`: the session's model. */
    const settingsMetadata = (descriptor: SessionDescriptor): Stream.Stream<Emission> =>
      Stream.fromEffect(
        fs.readFileString(descriptor.sourcePath.replace(/\.jsonl$/, ".settings.json")).pipe(
          Effect.map((text) => Option.flatMap(parseJson(text), decodeSettings)),
          Effect.orElseSucceed(() => Option.none())
        )
      ).pipe(
        Stream.flatMap((settings) =>
          Option.isSome(settings) && settings.value.model !== undefined
            ? Stream.succeed(Emission.metadata({ metadata: { model: settings.value.model } }))
            : Stream.empty
        )
      )

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: DroidCapabilities,
      detect: {
        executables: ["droid"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: [sessionsDir, projectsDir]
      },
      roots: [sessionsDir, projectsDir],
      classify: classifyDroidFile,
      headLines: 3,
      inspect: inspectDroidHead,
      // The same session copied under both roots: the current layout wins.
      priority: (candidate) => (candidate.path.startsWith(sessionsDir + path.sep) ? 1 : 0),
      // Not tailed: Droid rewrites line 1 (`session_start`) in place, which shifts every byte offset.
      read: (descriptor) =>
        Stream.concat(
          settingsMetadata(descriptor),
          readLines(fs, harness, descriptor.sourcePath).pipe(
            Stream.map(decodeLine),
            Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath), normalizeLine)
          )
        )
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(DroidAdapter, DroidAdapter.make)
}
