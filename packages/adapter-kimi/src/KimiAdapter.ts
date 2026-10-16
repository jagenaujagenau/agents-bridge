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
  readLines,
  stringProp
} from "@agentbridge/core"
import { type HarnessId, makeSessionId, noCapabilities, type SessionDescriptor } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { decodeLine, HARNESS, initialState, NAME, normalizeLine } from "./KimiNormalizer.ts"
import { SessionState } from "./schema/KimiRecord.ts"

const harness = HARNESS as HarnessId

export const KimiCapabilities = {
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

export const MAIN_AGENT = "main"

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** A session's native ID is its directory name; a subagent's is `<session>/<agentId>`. */
export const splitNativeId = (nativeId: string): { readonly root: string; readonly agentId: string } => {
  const slash = nativeId.indexOf("/")
  return slash === -1 ? { root: nativeId, agentId: MAIN_AGENT } : { root: nativeId.slice(0, slash), agentId: nativeId.slice(slash + 1) }
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/

/**
 * `sessions/<wd_slug_hash>/<sessionId>/agents/<agentId>/wire.jsonl`. The `main` agent's wire
 * is the session; every other agent (`agent-N`) is a subagent session. Blobs, task output,
 * file-history backups and plans beside the wires are not sessions.
 */
export const classifyKimiFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  if (parts.length !== 5 || parts[4] !== "wire.jsonl" || parts[2] !== "agents") return undefined
  const sessionId = parts[1]!
  const agentId = parts[3]!
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(agentId) || sessionId === "." || sessionId === ".." || agentId === "." || agentId === "..") {
    return undefined
  }
  return { path: absolute, nativeId: agentId === MAIN_AGENT ? sessionId : `${sessionId}/${agentId}` }
}

/** The wire header: `{ "type": "metadata", "protocol_version": "1.5", "created_at": <ms> }`. */
export const inspectKimiHead = (head: ReadonlyArray<string>): HeadFacts => {
  const first = head[0] === undefined ? Option.none() : parseJson(head[0])
  if (Option.isNone(first) || stringProp(first.value, "type") !== "metadata") return {}
  const createdAt = (first.value as { created_at?: unknown }).created_at
  return typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0
    ? { startedAt: new Date(createdAt).toISOString() }
    : {}
}

const epochIso = (value: number | string | undefined): string | undefined => {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined
  return value
}

/**
 * Facts from `state.json` for one agent's wire: the working directory, the creation time, and
 * for subagents the agent that spawned them (`labels.parentAgentId`, else `parentAgentId`).
 */
export const stateFacts = (state: SessionState | undefined, nativeId: string): HeadFacts => {
  const { agentId, root } = splitNativeId(nativeId)
  const cwd = state?.cwd ?? state?.workDir
  const startedAt = epochIso(state?.createdAt)
  const facts: HeadFacts = {
    ...(cwd !== undefined && cwd.length > 0 ? { projectPath: cwd } : {}),
    ...(startedAt !== undefined ? { startedAt } : {})
  }
  if (agentId === MAIN_AGENT) return facts
  const agent = state?.agents?.[agentId]
  const labels = (agent as { labels?: unknown } | undefined)?.labels
  const parent = stringProp(labels, "parentAgentId") ?? stringProp(agent, "parentAgentId")
  const label = stringProp(labels, "profileName")
  return {
    ...facts,
    // Spawned by the main agent, or unknown (no state): the session itself.
    parentNativeId: parent === undefined || parent === MAIN_AGENT || parent === agentId ? root : `${root}/${parent}`,
    ...(label !== undefined ? { agentLabel: label } : {})
  }
}

const TITLE_PRIORITY: Record<string, number> = { custom: 40, generated: 30, replaceable: 20 }

/** Session-level metadata from `state.json`, emitted before the wire is read. */
export const stateMetadata = (state: SessionState, descriptor: SessionDescriptor): Emission | undefined => {
  const { agentId } = splitNativeId(descriptor.nativeId)
  const main = agentId === MAIN_AGENT
  const cwd = state.cwd ?? state.workDir
  const title = state.title?.trim()
  const kind = state.isCustomTitle === true ? "custom" : state.titleKind ?? "replaceable"
  const patch = {
    ...(cwd !== undefined && cwd.length > 0 ? { projectPath: cwd } : {}),
    ...(main && title !== undefined && title.length > 0 && title !== "New Session"
      ? { title: { value: title, priority: TITLE_PRIORITY[kind] ?? 20 } }
      : {}),
    ...(main && state.forkedFrom !== undefined && state.forkedFrom.length > 0
      ? { relationships: [{ type: "fork" as const, from: descriptor.id, to: makeSessionId(HARNESS, state.forkedFrom) }] }
      : {})
  }
  return Object.keys(patch).length > 0 ? Emission.metadata(patch) : undefined
}

const decodeState = Schema.decodeUnknownOption(SessionState)

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class KimiAdapter extends Context.Service<KimiAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-kimi/KimiAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const kimiHome = yield* harnessRoot("KIMI_CODE_HOME", ".kimi-code")
    // Only `sessions/` is walked: `credentials/`, `config.toml`, `mcp.json` and the OAuth
    // stores beside it are never opened.
    const sessionsDir = path.join(kimiHome, "sessions")

    /** `<session dir>/state.json` (or the older `session-meta/state.json`), if readable. */
    const readState = (wirePath: string): Effect.Effect<SessionState | undefined> => {
      const sessionDir = path.dirname(path.dirname(path.dirname(wirePath)))
      const read = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.map((text) => Option.getOrUndefined(Option.flatMap(parseJson(text), decodeState))),
          Effect.orElseSucceed(() => undefined)
        )
      return read(path.join(sessionDir, "state.json")).pipe(
        Effect.flatMap((state) => (state !== undefined ? Effect.succeed(state) : read(path.join(sessionDir, "session-meta", "state.json"))))
      )
    }

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: KimiCapabilities,
      detect: {
        executables: ["kimi"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: [sessionsDir]
      },
      roots: [sessionsDir],
      classify: classifyKimiFile,
      headLines: 1,
      inspect: inspectKimiHead,
      enrich: (candidate) => Effect.map(readState(candidate.path), (state) => stateFacts(state, candidate.nativeId ?? "")),
      // Not tailed: Kimi rewrites a wire in place when it migrates an older protocol or repairs a torn tail on resume.
      read: (descriptor) =>
        Stream.concat(
          Stream.fromEffect(readState(descriptor.sourcePath)).pipe(
            Stream.flatMap((state) => {
              const emission = state === undefined ? undefined : stateMetadata(state, descriptor)
              return emission === undefined ? Stream.empty : Stream.succeed(emission)
            })
          ),
          readLines(fs, harness, descriptor.sourcePath).pipe(
            Stream.map(decodeLine),
            Stream.mapAccum(
              () => initialState(descriptor.id, descriptor.sourcePath, splitNativeId(descriptor.nativeId).root),
              normalizeLine
            )
          )
        )
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(KimiAdapter, KimiAdapter.make)
}
