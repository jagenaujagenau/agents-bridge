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
import { activePath, decodeLine, HARNESS, initialState, NAME, normalizeLine, onPath, type TreeEntry } from "./QwenNormalizer.ts"
import { SIDE_SUBTYPES } from "./schema/QwenRecord.ts"

const harness = HARNESS as HarnessId

export const QwenCodeCapabilities = {
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

/** `SESSION_FILE_PATTERN` in Qwen Code's session service; also excludes `<id>.ledger.jsonl`. */
const SESSION_FILE = /^([0-9a-fA-F-]{32,36})\.jsonl$/
const AGENT_FILE = /^(agent-[A-Za-z0-9_-]+)\.jsonl$/

/**
 * Map a file under `projects/` to a candidate.
 * Session: `<project>/chats/<sessionId>.jsonl` or `<project>/chats/archive/<sessionId>.jsonl`.
 * Subagent: `<project>/subagents/<parentSessionId>/agent-<agentId>.jsonl`.
 * Sidecars (`.ledger.jsonl`, `.runtime.json`, `.meta.json`, `.jsonl.stream`) never match.
 */
export const classifyQwenFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  const [, area, third, fourth] = parts
  if (area === "chats" && parts.length === 3 && third !== undefined) {
    const id = SESSION_FILE.exec(third)?.[1]
    return id ? { path: absolute, nativeId: id } : undefined
  }
  if (area === "chats" && parts.length === 4 && third === "archive" && fourth !== undefined) {
    const id = SESSION_FILE.exec(fourth)?.[1]
    return id ? { path: absolute, nativeId: id } : undefined
  }
  if (area === "subagents" && parts.length === 4 && third !== undefined && fourth !== undefined) {
    const agent = AGENT_FILE.exec(fourth)?.[1]
    return agent ? { path: absolute, nativeId: `${third}/${agent}`, parentNativeId: third } : undefined
  }
  return undefined
}

export class QwenCodeAdapter extends Context.Service<QwenCodeAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-qwen-code/QwenCodeAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    // Storage.getRuntimeBaseDir: QWEN_RUNTIME_DIR, else QWEN_HOME, else ~/.qwen.
    const expand = (dir: string) =>
      host.home !== undefined && (dir === "~" || dir.startsWith("~/")) ? path.join(host.home, dir.slice(1)) : dir
    const override = (yield* host.variable("QWEN_RUNTIME_DIR")) || (yield* host.variable("QWEN_HOME"))
    const runtimeDir = override ? expand(override) : path.join(host.home ?? ".", ".qwen")
    const projectsDir = path.join(runtimeDir, "projects")

    /** The subagent's type from its `agent-<id>.meta.json` sidecar. */
    const agentType = (candidate: FileCandidate) =>
      candidate.parentNativeId === undefined
        ? Effect.succeed({})
        : fs.readFileString(candidate.path.replace(/\.jsonl$/, ".meta.json")).pipe(
          Effect.map((text) => {
            const label = stringProp(Option.getOrUndefined(parseJson(text)), "agentType")
            return label !== undefined ? { agentLabel: label } : {}
          }),
          Effect.orElseSucceed(() => ({}))
        )

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: QwenCodeCapabilities,
      detect: {
        executables: ["qwen"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: [projectsDir]
      },
      roots: [projectsDir],
      classify: classifyQwenFile,
      headLines: 1,
      inspect: (head) => {
        const first = Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(head[0]), parseJson))
        const agentName = stringProp(first, "agentName")
        return {
          projectPath: stringProp(first, "cwd"),
          startedAt: stringProp(first, "timestamp"),
          ...(agentName !== undefined ? { agentLabel: agentName } : {})
        }
      },
      enrich: agentType,
      // An archived and an active copy of one session: the active one is current.
      priority: (candidate) => (candidate.path.includes(`${path.sep}archive${path.sep}`) ? 0 : 1),
      read: (descriptor) => {
        const lines = readLines(fs, harness, descriptor.sourcePath)
        // First pass: the record tree, to drop branches abandoned by /rewind.
        const branch = lines.pipe(
          Stream.filterMap(({ line }) => {
            const record = Option.getOrUndefined(parseJson(line))
            const uuid = stringProp(record, "uuid")
            return uuid === undefined
              ? Result.fail(undefined)
              : Result.succeed<TreeEntry>({
                uuid,
                parentUuid: stringProp(record, "parentUuid"),
                side: stringProp(record, "type") === "system" && SIDE_SUBTYPES.has(stringProp(record, "subtype") ?? "")
              })
          }),
          Stream.runCollect,
          Effect.map(activePath)
        )
        return Stream.unwrap(Effect.map(branch, (active) =>
          lines.pipe(
            Stream.map(decodeLine),
            Stream.filter(onPath(active)),
            Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath), normalizeLine)
          )))
      }
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(QwenCodeAdapter, QwenCodeAdapter.make)
}
