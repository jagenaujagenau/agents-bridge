import {
  commonBinDirs,
  type FileCandidate,
  type HarnessAdapterShape,
  harnessRoot,
  HostEnvironment,
  makeFileHistoryAdapter,
  parseJson,
  readLines,
  stringProp
} from "@agentbridge/core"
import { type HarnessId, noCapabilities } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Result, Stream } from "effect"
import {
  activePath,
  decodeLine,
  HARNESS,
  idFromFileName,
  idFromStem,
  initialState,
  NAME,
  normalizeLine,
  onPath
} from "./PiNormalizer.ts"

const harness = HARNESS as HarnessId

export const PiCapabilities = {
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

/**
 * Map a transcript to a candidate.
 * Top level: `<encoded-cwd>/<timestamp>_<id>.jsonl`.
 * Spawned run: `<encoded-cwd>/<timestamp>_<parentId>/<agent>/run-N/<file>.jsonl`; its own id is in its header.
 * With `flat`, the root is a custom session directory (`PI_CODING_AGENT_SESSION_DIR`), which holds
 * the transcripts directly, without the `<encoded-cwd>` level.
 */
export const classifyPiFile = (parts: ReadonlyArray<string>, absolute: string, flat = false): FileCandidate | undefined => {
  if (flat) return classifyPiFile(["", ...parts], absolute)
  const file = parts[parts.length - 1]
  if (file === undefined || !file.endsWith(".jsonl")) return undefined
  if (parts.length === 2) return { path: absolute, nativeId: idFromFileName(file) }
  const sessionDir = parts.slice(0, -1).findLastIndex((part) => idFromStem(part) !== undefined)
  if (sessionDir < 0 || sessionDir === parts.length - 2) return undefined
  return { path: absolute, parentNativeId: idFromStem(parts[sessionDir]!), agentLabel: parts[sessionDir + 1] }
}

/** `~` and `~/…` as pi expands them. */
export const expandHome = (value: string, home: string | undefined): string =>
  home !== undefined && (value === "~" || value.startsWith("~/")) ? `${home}${value.slice(1)}` : value

export class PiAdapter extends Context.Service<PiAdapter, HarnessAdapterShape>()("@agentbridge/adapter-pi/PiAdapter") {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const agentDir = yield* harnessRoot("PI_CODING_AGENT_DIR", ".pi", "agent")
    const sessionsDir = path.join(agentDir, "sessions")
    const host = yield* HostEnvironment
    // pi writes every session to this directory, flat, when the variable is set.
    const customDir = yield* host.variable("PI_CODING_AGENT_SESSION_DIR")
    const custom = customDir === undefined || customDir.length === 0 ? undefined : path.resolve(expandHome(customDir, host.home))
    // Pointing it at the default sessions root changes nothing.
    const flatDir = custom === path.resolve(sessionsDir) ? undefined : custom

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: PiCapabilities,
      detect: {
        executables: ["pi"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: flatDir === undefined ? [sessionsDir] : [sessionsDir, flatDir]
      },
      roots: flatDir === undefined ? [sessionsDir] : [sessionsDir, flatDir],
      classify: (parts, absolute, root) => classifyPiFile(parts, absolute, root === flatDir),
      headLines: 1,
      inspect: (head) => {
        const header = Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(head[0]), parseJson))
        return {
          nativeId: stringProp(header, "id"),
          projectPath: stringProp(header, "cwd"),
          startedAt: stringProp(header, "timestamp")
        }
      },
      mayBe: () => true,
      read: (descriptor) => {
        const lines = readLines(fs, harness, descriptor.sourcePath)
        const decoded = lines.pipe(Stream.map(decodeLine))
        // First pass: the tree shape of every entry, including types the normalizer ignores.
        const branch = lines.pipe(
          Stream.filterMap(({ line }) => {
            const entry = Option.getOrUndefined(parseJson(line))
            const id = stringProp(entry, "id")
            return id !== undefined && stringProp(entry, "type") !== "session"
              ? Result.succeed([id, stringProp(entry, "parentId")] as const)
              : Result.fail(undefined)
          }),
          Stream.runCollect,
          Effect.map(activePath)
        )
        return Stream.unwrap(Effect.map(branch, (path) =>
          decoded.pipe(
            Stream.filter(onPath(path)),
            Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath), normalizeLine)
          )))
      }
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(PiAdapter, PiAdapter.make)
}
