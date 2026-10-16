import {
  commonBinDirs,
  Emission,
  type FileCandidate,
  type HarnessAdapterShape,
  harnessRoot,
  type HeadFacts,
  HostEnvironment,
  makeFileHistoryAdapter,
  parseJson,
  readLines
} from "@agentbridge/core"
import { type HarnessId, noCapabilities } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import {
  decodeLine,
  HARNESS,
  initialState,
  isSubagentSummary,
  NAME,
  normalizeLine,
  onHalt,
  summaryMetadata
} from "./GrokNormalizer.ts"
import { GrokSummary } from "./schema/GrokRecord.ts"

const harness = HARNESS as HarnessId

export const GrokCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  // Grok records token totals per agent-loop run (`turn_completed`), not per model call:
  // they are kept as session metadata (`tokenTotals`), never as usage events.
  tokenUsage: false,
  subagents: true
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Grok's own rule for session IDs (a UUIDv7, or a client-supplied ID). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * `sessions/<encoded-cwd>/<session-id>/updates.jsonl`. Everything else in a session directory
 * (`chat_history.jsonl`, `subagents/<id>/meta.json`, `compaction_checkpoints/`) and everything
 * outside `sessions/` (`auth.json`, `config.toml`) is not a session.
 */
export const classifyGrokFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined =>
  parts.length === 3 && parts[2] === "updates.jsonl" && parts[0]!.length > 0 && SESSION_ID.test(parts[1]!)
    ? { path: absolute, nativeId: parts[1]! }
    : undefined

/** The group directory is `encodeURIComponent(cwd)`; long paths use a slug and a `.cwd` file instead. */
export const decodeCwdDir = (name: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(name)
    return decoded !== name && (decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded) || decoded.startsWith("\\\\"))
      ? decoded
      : undefined
  } catch {
    return undefined
  }
}

/** The first update's receive time. */
export const inspectGrokHead = (head: ReadonlyArray<string>): HeadFacts => {
  const first = head[0] === undefined ? Option.none() : parseJson(head[0])
  if (Option.isNone(first) || typeof first.value !== "object" || first.value === null) return {}
  const record = first.value as { readonly timestamp?: unknown; readonly params?: { readonly _meta?: Record<string, unknown> } }
  const ms = record.params?._meta?.["agentTimestampMs"]
  if (typeof ms === "number" && Number.isFinite(ms)) return { startedAt: new Date(ms).toISOString() }
  if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) {
    return { startedAt: new Date(Math.round(record.timestamp * 1000)).toISOString() }
  }
  return {}
}

const decodeSummary = Schema.decodeUnknownOption(GrokSummary)

export class GrokAdapter extends Context.Service<GrokAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-grok/GrokAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    // GROK_HOME replaces ~/.grok. Only `sessions/` is walked: credentials (`auth.json`) and
    // configuration elsewhere in the home are never read.
    const grokHome = yield* harnessRoot("GROK_HOME", ".grok")
    const sessionsDir = path.join(grokHome, "sessions")

    const readSummary = (sessionDir: string): Effect.Effect<Option.Option<GrokSummary>> =>
      fs.readFileString(path.join(sessionDir, "summary.json")).pipe(
        Effect.map((text) => Option.flatMap(parseJson(text), decodeSummary)),
        Effect.orElseSucceed(() => Option.none<GrokSummary>())
      )

    /** The working directory from the group directory: its encoded name, or its `.cwd` file. */
    const groupCwd = (groupDir: string): Effect.Effect<string | undefined> => {
      const decoded = decodeCwdDir(path.basename(groupDir))
      return decoded !== undefined
        ? Effect.succeed(decoded)
        : fs.readFileString(path.join(groupDir, ".cwd")).pipe(
          Effect.map((text) => text.trim() || undefined),
          Effect.orElseSucceed(() => undefined)
        )
    }

    const enrich = (candidate: FileCandidate): Effect.Effect<HeadFacts> =>
      Effect.gen(function*() {
        const sessionDir = path.dirname(candidate.path)
        const summary = Option.getOrUndefined(yield* readSummary(sessionDir))
        const cwd = summary?.info?.cwd ?? (yield* groupCwd(path.dirname(sessionDir)))
        const parent = summary !== undefined && isSubagentSummary(summary) ? summary.parent_session_id ?? undefined : undefined
        return {
          ...(cwd !== undefined ? { projectPath: cwd } : {}),
          ...(summary?.created_at ? { startedAt: summary.created_at } : {}),
          ...(parent ? { parentNativeId: parent } : {}),
          ...(parent && summary?.subagent_type ? { agentLabel: summary.subagent_type } : {})
        }
      })

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: GrokCapabilities,
      detect: {
        executables: ["grok"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: [sessionsDir]
      },
      roots: [sessionsDir],
      classify: classifyGrokFile,
      headLines: 1,
      inspect: inspectGrokHead,
      enrich,
      // Not tailed: rewind and compaction rewrite `updates.jsonl` in place.
      read: (descriptor) =>
        Stream.concat(
          Stream.fromEffect(readSummary(path.dirname(descriptor.sourcePath))).pipe(
            Stream.flatMap((summary) =>
              Option.isSome(summary) ? Stream.succeed(Emission.metadata(summaryMetadata(summary.value, descriptor.id))) : Stream.empty
            )
          ),
          readLines(fs, harness, descriptor.sourcePath).pipe(
            Stream.map(decodeLine),
            Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath), normalizeLine, { onHalt })
          )
        )
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(GrokAdapter, GrokAdapter.make)
}
