import { expandHome, idFromFileName, idFromStem, initialState } from "@agentbridge/adapter-pi"
import {
  commonBinDirs,
  type FileCandidate,
  type HarnessAdapterShape,
  HostEnvironment,
  makeFileHistoryAdapter,
  parseJson,
  readLines,
  stringProp
} from "@agentbridge/core"
import { type HarnessId, noCapabilities } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Result, Stream } from "effect"
import { decodeLine, HARNESS, NAME, normalizeLine, ompActivePath, ompDialect, onPath, type TreeEntry } from "./OmpNormalizer.ts"

const harness = HARNESS as HarnessId

export const OmpCapabilities = {
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
 *
 * - Session: `<dir>/<timestamp>_<id>.jsonl` (`<dir>` encodes the cwd; absent in a flat custom directory).
 * - Subagent: `<dir>/<timestamp>_<id>/<AgentId>.jsonl`. A subagent's own children live in its artifact
 *   directory with dotted IDs: `<dir>/<timestamp>_<id>/Anna/Anna.Bob.jsonl`.
 *
 * Subagent IDs are `<root id>/<AgentId>` (agent IDs are unique within a root session), so the parent
 * of `Anna.Bob` is `<root id>/Anna`. Advisor transcripts (`__advisor*`) and backups are not sessions.
 */
export const classifyOmpFile = (parts: ReadonlyArray<string>, absolute: string, flat = false): FileCandidate | undefined => {
  if (flat) return classifyOmpFile(["", ...parts], absolute)
  const file = parts[parts.length - 1]
  if (file === undefined || !file.endsWith(".jsonl") || file.includes(".bak") || file.startsWith("__advisor")) return undefined
  if (parts.length === 2) return { path: absolute, nativeId: idFromFileName(file) }
  const rootId = parts[1] === undefined ? undefined : idFromStem(parts[1])
  if (rootId === undefined) return undefined
  const agentId = file.slice(0, -".jsonl".length)
  const dirs = parts.slice(2, -1)
  const dot = agentId.lastIndexOf(".")
  const parent = dot > 0 ? agentId.slice(0, dot) : dirs.at(-1)
  return {
    path: absolute,
    nativeId: `${rootId}/${agentId}`,
    parentNativeId: parent === undefined ? rootId : `${rootId}/${parent}`,
    agentLabel: agentId.slice(dot + 1)
  }
}

/** The tree shape of one raw line, for the branch pass. */
const treeEntry = (line: string): Result.Result<TreeEntry, undefined> => {
  const entry = Option.getOrUndefined(parseJson(line))
  const id = stringProp(entry, "id")
  const type = stringProp(entry, "type")
  if (id === undefined || type === "session" || type === "title") return Result.fail(undefined)
  const activeLeafId = (entry as { activeLeafId?: unknown }).activeLeafId
  return Result.succeed({
    id,
    parentId: stringProp(entry, "parentId"),
    type,
    ...(typeof activeLeafId === "string" || activeLeafId === null ? { activeLeafId } : {})
  })
}

/** Variables that locate omp history. */
export const OMP_ENVIRONMENT = [
  "OMP_CODING_AGENT_DIR",
  "OMP_CODING_AGENT_SESSION_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CONFIG_DIR",
  "XDG_DATA_HOME"
] as const

/**
 * Where omp keeps sessions, following its directory resolver:
 *
 * - `~/.omp/agent/sessions`; `PI_CONFIG_DIR` renames `.omp`.
 * - A profile (`OMP_PROFILE`, else `PI_PROFILE`; an empty `OMP_PROFILE` selects the default):
 *   `~/.omp/profiles/<name>/agent/sessions`.
 * - After `omp config migrate`, `$XDG_DATA_HOME/omp/sessions` (or `…/omp/profiles/<name>/sessions`).
 *
 * omp's own `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` overrides are shared with pi: in
 * Bridge's environment they would make both adapters read the same files. Bridge reads
 * `OMP_CODING_AGENT_DIR` (agent directory, replacing the above) and `OMP_CODING_AGENT_SESSION_DIR`
 * (an extra flat session directory) instead.
 */
export const ompSessionRoots = (
  path: Path.Path,
  home: string | undefined,
  env: Readonly<Record<string, string | undefined>>
): { readonly roots: ReadonlyArray<string>; readonly flatDir: string | undefined } => {
  const variable = (name: string) => (env[name]?.trim() ? env[name]!.trim() : undefined)
  const agentDirOverride = variable("OMP_CODING_AGENT_DIR")
  const profile = env["OMP_PROFILE"] !== undefined ? variable("OMP_PROFILE") : variable("PI_PROFILE")
  const configRoot = path.join(home ?? ".", variable("PI_CONFIG_DIR") ?? ".omp")
  const agentDir = agentDirOverride !== undefined
    ? expandHome(agentDirOverride, home)
    : profile !== undefined
    ? path.join(configRoot, "profiles", profile, "agent")
    : path.join(configRoot, "agent")
  const xdgData = agentDirOverride === undefined ? variable("XDG_DATA_HOME") : undefined
  const managed = [
    path.join(agentDir, "sessions"),
    ...(xdgData === undefined
      ? []
      : [profile === undefined ? path.join(xdgData, "omp", "sessions") : path.join(xdgData, "omp", "profiles", profile, "sessions")])
  ]
  const custom = variable("OMP_CODING_AGENT_SESSION_DIR")
  // A custom directory that is one of the managed roots changes nothing.
  const flatDir = custom === undefined || managed.some((root) => path.resolve(root) === path.resolve(expandHome(custom, home)))
    ? undefined
    : expandHome(custom, home)
  return { roots: flatDir === undefined ? managed : [...managed, flatDir], flatDir }
}

export class OmpAdapter extends Context.Service<OmpAdapter, HarnessAdapterShape>()("@agentbridge/adapter-omp/OmpAdapter") {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const env: Record<string, string | undefined> = {}
    for (const name of OMP_ENVIRONMENT) env[name] = yield* host.variable(name)
    const { roots, flatDir } = ompSessionRoots(path, host.home, env)

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: OmpCapabilities,
      detect: {
        executables: ["omp"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: roots
      },
      roots,
      classify: (parts, absolute, root) => classifyOmpFile(parts, absolute, root === flatDir),
      // Line 1 is the title slot; the session header follows it.
      headLines: 2,
      inspect: (head) => {
        const header = head
          .map((line) => Option.getOrUndefined(parseJson(line)))
          .find((entry) => stringProp(entry, "type") === "session")
        return {
          nativeId: stringProp(header, "id"),
          projectPath: stringProp(header, "cwd"),
          startedAt: stringProp(header, "timestamp")
        }
      },
      mayBe: () => true,
      read: (descriptor) => {
        const lines = readLines(fs, harness, descriptor.sourcePath)
        // First pass: the tree shape of every entry, including types the normalizer ignores.
        const branch = lines.pipe(
          Stream.filterMap(({ line }) => treeEntry(line)),
          Stream.runCollect,
          Effect.map(ompActivePath)
        )
        const subagent = descriptor.parentSessionId !== undefined
        return Stream.unwrap(Effect.map(branch, (active) =>
          lines.pipe(
            Stream.map(decodeLine),
            Stream.filter(onPath(active)),
            Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath, ompDialect), normalizeLine(subagent))
          )))
      }
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(OmpAdapter, OmpAdapter.make)
}
