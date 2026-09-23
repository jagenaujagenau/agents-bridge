import {
  commonBinDirs,
  cacheDiscovery,
  isWithinProject,
  detectHarness,
  harnessRoot,
  HostEnvironment,
  type HarnessAdapterShape,
  listFilesRecursive,
  type ListSessionsOptions,
  parseJson,
  readHeadLines,
  readLines,
  SessionNotFound,
  type SessionReadError,
  statFile,
  toIso,
  VersionProbe
} from "@agentbridge/core"
import {
  type DetectionResult,
  type HarnessId,
  makeSessionId,
  noCapabilities,
  parseSessionId,
  type SessionDescriptor,
  type SessionId
} from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { FORMAT, HARNESS, initialState, normalizeLine } from "./CodexNormalizer.ts"
import { decodeLine } from "./CodexSource.ts"
import { RolloutLine, SessionMeta, SubagentSource } from "./schema/CodexRecord.ts"

const harness = HARNESS as HarnessId

export const CodexCapabilities = {
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const ROLLOUT = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export const rolloutId = (fileName: string): string | undefined => ROLLOUT.exec(fileName)?.[1]?.toLowerCase()

const decodeRolloutLine = Schema.decodeUnknownOption(RolloutLine)
const decodeMeta = Schema.decodeUnknownOption(SessionMeta)
const decodeSubagent = Schema.decodeUnknownOption(SubagentSource)

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CodexAdapter extends Context.Service<CodexAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-codex/CodexAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const detectContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | HostEnvironment | VersionProbe>()
    // CODEX_HOME replaces ~/.codex.
    const codexHome = yield* harnessRoot("CODEX_HOME", ".codex")
    const sessionsDir = path.join(codexHome, "sessions")

    const detect: Effect.Effect<DetectionResult> = detectHarness({
      harness,
      name: "Codex",
      executables: ["codex"],
      extraDirs: commonBinDirs(path, host.home),
      historyPaths: [sessionsDir]
    }).pipe(Effect.provideContext(detectContext))

    const rollouts = Effect.map(
      listFilesRecursive(fs, path, harness, sessionsDir),
      (files) => files.filter((file) => rolloutId(path.basename(file)) !== undefined)
    )

    const discovery = yield* cacheDiscovery(rollouts)

    const describe = (file: string): Effect.Effect<SessionDescriptor, SessionReadError> =>
      Effect.gen(function*() {
        const info = yield* statFile(fs, harness, file)
        const head = yield* readHeadLines(fs, harness, file, 1)
        const meta = Option.flatMap(
          Option.flatMap(Option.fromNullishOr(head[0]), parseJson),
          (json) =>
            Option.flatMap(decodeRolloutLine(json), (line) =>
              line.type === "session_meta" ? decodeMeta(line.payload) : Option.none())
        )
        const nativeId = rolloutId(path.basename(file)) ?? Option.getOrThrow(Option.map(meta, (m) => m.id))
        const spawn = Option.flatMap(meta, (m) => decodeSubagent(m.source))
        const cwd = Option.getOrUndefined(Option.flatMapNullishOr(meta, (m) => m.cwd))
        const startedAt = Option.getOrUndefined(Option.flatMapNullishOr(meta, (m) => m.timestamp))
        const updatedAt = toIso(info.modifiedAt)
        const parent = Option.getOrUndefined(spawn)?.subagent.thread_spawn
        const agentLabel = parent?.agent_nickname ?? parent?.agent_role ?? undefined
        return {
          id: makeSessionId(HARNESS, nativeId),
          harness,
          nativeId,
          sourcePath: file,
          sizeBytes: info.sizeBytes,
          ...(cwd !== undefined ? { projectPath: cwd } : {}),
          ...(parent !== undefined ? { parentSessionId: makeSessionId(HARNESS, parent.parent_thread_id) } : {}),
          ...(agentLabel !== undefined ? { agentLabel } : {}),
          ...(startedAt !== undefined && !Number.isNaN(Date.parse(startedAt)) ? { startedAt } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {})
        }
      })

    const listSessions = (options?: ListSessionsOptions) =>
      Stream.fromEffect(options?.refresh ? discovery.refresh : discovery.get).pipe(
        Stream.flatMap((files) => Stream.fromIterable(files)),
        Stream.mapEffect(describe, { concurrency: 8 }),
        Stream.filter((d) =>
          (options?.since === undefined || (d.updatedAt !== undefined && Date.parse(d.updatedAt) >= options.since.getTime())) &&
          (options?.projectPath === undefined || isWithinProject(path, d.projectPath, options.projectPath))
        )
      )

    const resolve = (id: SessionId) =>
      Effect.gen(function*() {
        const parsed = parseSessionId(id)
        if (parsed === undefined || parsed.harness !== harness) return yield* new SessionNotFound({ sessionId: id })
        const files = yield* discovery.get
        const file = files.find((f) => rolloutId(path.basename(f)) === parsed.nativeId.toLowerCase())
        if (file === undefined) return yield* new SessionNotFound({ sessionId: id })
        return yield* describe(file)
      })

    const read = (descriptor: SessionDescriptor) =>
      readLines(fs, harness, descriptor.sourcePath).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath), normalizeLine),
        Stream.withSpan("bridge.normalize-session", { attributes: { harness, format: FORMAT } })
      )

    const adapter: HarnessAdapterShape = {
      id: harness,
      name: "Codex",
      capabilities: CodexCapabilities,
      detect,
      listSessions,
      resolve: (id) => resolve(id).pipe(Effect.catchTag("SessionNotFound", () => Effect.andThen(discovery.invalidate, resolve(id)))),
      read
    }
    return adapter
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(CodexAdapter, CodexAdapter.make)
}
