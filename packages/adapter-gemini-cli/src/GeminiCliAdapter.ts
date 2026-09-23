import {
  commonBinDirs,
  describeCause,
  Emission,
  type FileCandidate,
  type HarnessAdapterShape,
  harnessRoot,
  HostEnvironment,
  makeFileHistoryAdapter,
  parseJson,
  SessionReadError
} from "@agentbridge/core"
import { type HarnessId, noCapabilities, sha256Hex, isTimestamp } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { FORMAT, HARNESS, initialState, NAME, normalizeMessage } from "./GeminiNormalizer.ts"
import { GeminiConversation } from "./schema/GeminiRecord.ts"

const harness = HARNESS as HarnessId

export const GeminiCliCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  tokenUsage: true
}

/** `<project>/chats/session-<time>-<id>.json` */
export const classifyGeminiFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  const [project, chats, file] = parts
  if (parts.length !== 3 || project === undefined || chats !== "chats" || file === undefined) return undefined
  const match = /^session-(.+)\.json$/.exec(file)
  return match ? { path: absolute, nativeId: match[1] } : undefined
}

/** `2026-02-23T04-07-<id>` → `2026-02-23T04:07:00Z` */
export const startFromNativeId = (nativeId: string): string | undefined => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})(?:-(\d{2})(?=-))?-/.exec(nativeId)
  const value = match ? `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}Z` : undefined
  return value !== undefined && isTimestamp(value) ? value : undefined
}

const decodeConversation = Schema.decodeUnknownOption(GeminiConversation)

const validIso = (value: string | undefined) => {
  const millis = value === undefined ? Number.NaN : Date.parse(value)
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString()
}

export class GeminiCliAdapter extends Context.Service<GeminiCliAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-gemini-cli/GeminiCliAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    // GEMINI_CLI_HOME replaces the home directory that contains `.gemini`.
    const geminiDir = path.join(yield* harnessRoot("GEMINI_CLI_HOME"), ".gemini")
    const tmpDir = path.join(geminiDir, "tmp")

    const readJson = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text) => Option.getOrUndefined(parseJson(text))),
        Effect.orElseSucceed(() => undefined)
      )

    /** Project directory names are either sha256(project root) or a short name from projects.json. */
    const projectRoots = yield* Effect.cached(
      Effect.gen(function*() {
        const byKey = new Map<string, string>()
        const projects = yield* readJson(path.join(geminiDir, "projects.json"))
        const named = typeof projects === "object" && projects !== null && "projects" in projects
          ? (projects as { projects: unknown }).projects
          : undefined
        if (typeof named === "object" && named !== null) {
          for (const [root, name] of Object.entries(named)) {
            byKey.set(sha256Hex(root), root)
            if (typeof name === "string") byKey.set(name, root)
          }
        }
        const trusted = yield* readJson(path.join(geminiDir, "trustedFolders.json"))
        if (typeof trusted === "object" && trusted !== null) {
          for (const root of Object.keys(trusted)) byKey.set(sha256Hex(root), root)
        }
        return byKey
      })
    )

    const projectPathOf = (sessionFile: string) =>
      Effect.gen(function*() {
        const projectDir = path.dirname(path.dirname(sessionFile))
        const marker = yield* fs.readFileString(path.join(projectDir, ".project_root")).pipe(
          Effect.map((text) => text.trim() || undefined),
          Effect.orElseSucceed(() => undefined)
        )
        return marker ?? (yield* projectRoots).get(path.basename(projectDir))
      })

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: GeminiCliCapabilities,
      detect: {
        executables: ["gemini"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: [tmpDir]
      },
      roots: [tmpDir],
      classify: classifyGeminiFile,
      headLines: 0,
      enrich: (candidate) =>
        Effect.map(projectPathOf(candidate.path), (projectPath) => ({
          ...(projectPath !== undefined ? { projectPath } : {}),
          ...(candidate.nativeId !== undefined ? { startedAt: startFromNativeId(candidate.nativeId) } : {})
        })),
      read: (descriptor) =>
        Stream.unwrap(
          Effect.gen(function*() {
            const text = yield* fs.readFileString(descriptor.sourcePath).pipe(
              Effect.mapError((cause) =>
                new SessionReadError({ harness, path: descriptor.sourcePath, message: describeCause(cause) })
              )
            )
            const conversation = Option.getOrUndefined(Option.flatMap(parseJson(text), decodeConversation))
            if (conversation === undefined) {
              return Stream.succeed(Emission.warning({
                code: "malformed_json",
                message: "The chat file is not a valid Gemini CLI conversation",
                source: { provider: HARNESS, format: FORMAT, path: descriptor.sourcePath }
              }))
            }
            const header = Emission.metadata({
              ...(conversation.summary ? { title: { value: conversation.summary, priority: 30 } } : {}),
              ...(validIso(conversation.startTime) ? { startedAt: validIso(conversation.startTime)! } : {}),
              ...(validIso(conversation.lastUpdated) ? { updatedAt: validIso(conversation.lastUpdated)! } : {}),
              ...(conversation.sessionId ? { metadata: { geminiSessionId: conversation.sessionId } } : {})
            })
            return Stream.concat(
              Stream.succeed(header),
              Stream.fromIterable(conversation.messages.map((message, index) => [message, index] as const)).pipe(
                Stream.mapAccum(
                  () => initialState(descriptor.id, descriptor.sourcePath, descriptor.projectPath),
                  normalizeMessage
                )
              )
            )
          })
        )
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(GeminiCliAdapter, GeminiCliAdapter.make)
}
