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
  type ReadSourceOptions,
  SessionNotFound,
  statFile,
  toIso
} from "@agentbridge/core"
import {
  type HarnessId,
  makeSessionId,
  noCapabilities,
  parseSessionId,
  type SessionDescriptor,
  type SessionId
} from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { decodeLine, HARNESS, initialState, NAME, normalizeLine, onHalt, type View } from "./CopilotNormalizer.ts"

const harness = HARNESS as HarnessId

export const CopilotCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  // Output tokens per model call only: input and cache counts exist solely as session totals.
  tokenUsage: true,
  subagents: true
}

// ---------------------------------------------------------------------------
// workspace.yaml
// ---------------------------------------------------------------------------

export interface CopilotWorkspace {
  readonly id?: string
  readonly cwd?: string
  readonly git_root?: string
  readonly repository?: string
  readonly branch?: string
  readonly name?: string
  readonly summary?: string
  readonly created_at?: string
  readonly updated_at?: string
}

const WORKSPACE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "cwd",
  "git_root",
  "repository",
  "branch",
  "name",
  "summary",
  "created_at",
  "updated_at"
])

const unquote = (raw: string): string | undefined => {
  const value = raw.trim()
  if (value.length === 0 || value === "~" || value === "null" || value.startsWith("|") || value.startsWith(">")) return undefined
  if (value.startsWith("\"")) {
    const parsed = parseJson(value)
    return Option.isSome(parsed) && typeof parsed.value === "string" ? parsed.value : undefined
  }
  if (value.startsWith("'")) return value.endsWith("'") && value.length >= 2 ? value.slice(1, -1).replaceAll("''", "'") : undefined
  return value.replace(/\s+#.*$/, "")
}

/**
 * The flat `key: value` scalars Copilot writes to `workspace.yaml` (YAML `stringify` with
 * no line folding). Nested or block values are skipped: they are never needed here.
 */
export const parseWorkspaceYaml = (text: string): CopilotWorkspace => {
  const workspace: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_]+):(?:\s(.*))?$/.exec(line)
    if (match === null || !WORKSPACE_KEYS.has(match[1]!)) continue
    const value = unquote(match[2] ?? "")
    if (value !== undefined) workspace[match[1]!] = value
  }
  return workspace
}

/** Copilot's own display name: the user's name for the session, else its generated summary. */
export const workspaceTitle = (workspace: CopilotWorkspace): string | undefined => {
  const title = workspace.name?.trim() || workspace.summary?.trim()
  return title !== undefined && title.length > 0 ? title : undefined
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * `session-state/<sessionId>/events.jsonl`. The flat `session-state/<id>.jsonl` of early
 * releases is no longer read by Copilot itself and is skipped.
 */
export const classifyCopilotFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined =>
  parts.length === 2 && parts[1] === "events.jsonl" && parts[0]!.length > 0 ? { path: absolute, nativeId: parts[0]! } : undefined

/** `session.start` on the first line: start time and working directory. */
export const inspectHead = (head: ReadonlyArray<string>): HeadFacts => {
  const first = head[0] === undefined ? Option.none() : parseJson(head[0])
  if (Option.isNone(first) || typeof first.value !== "object" || first.value === null) return {}
  const record = first.value as { readonly type?: unknown; readonly data?: Record<string, unknown> }
  if (record.type !== "session.start" || typeof record.data !== "object" || record.data === null) return {}
  const startTime = record.data["startTime"]
  const context = record.data["context"] as Record<string, unknown> | undefined
  const cwd = typeof context === "object" && context !== null ? context["cwd"] : undefined
  return {
    ...(typeof startTime === "string" ? { startedAt: startTime } : {}),
    ...(typeof cwd === "string" ? { projectPath: cwd } : {})
  }
}

/** A subagent's native ID: `<sessionId>/<agentId>`. */
export const splitNativeId = (nativeId: string): { readonly root: string; readonly agentId: string | undefined } => {
  const slash = nativeId.indexOf("/")
  return slash === -1 ? { root: nativeId, agentId: undefined } : { root: nativeId.slice(0, slash), agentId: nativeId.slice(slash + 1) }
}

interface SpawnFacts {
  readonly label: string | undefined
  readonly startedAt: string | undefined
  /** Agent that made the `task` call, `undefined` for the root session. */
  readonly spawner: string | undefined
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CopilotAdapter extends Context.Service<CopilotAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-copilot/CopilotAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const copilotHome = yield* harnessRoot("COPILOT_HOME", ".copilot")
    const sessionStateDir = path.join(copilotHome, "session-state")

    const readWorkspace = (sessionDir: string): Effect.Effect<CopilotWorkspace> =>
      fs.readFileString(path.join(sessionDir, "workspace.yaml")).pipe(
        Effect.map(parseWorkspaceYaml),
        Effect.orElseSucceed((): CopilotWorkspace => ({}))
      )

    const readSession = (descriptor: SessionDescriptor, view: View, root: string, readOptions?: ReadSourceOptions) =>
      readLines(fs, harness, descriptor.sourcePath, { follow: readOptions?.follow }).pipe(
        Stream.map(decodeLine),
        Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath, root, view), normalizeLine, { onHalt })
      )

    const base = yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: CopilotCapabilities,
      detect: {
        executables: ["copilot"],
        extraDirs: commonBinDirs(path, host.home),
        historyPaths: [sessionStateDir]
      },
      roots: [sessionStateDir],
      classify: classifyCopilotFile,
      headLines: 1,
      inspect: inspectHead,
      enrich: (candidate) =>
        Effect.map(readWorkspace(path.dirname(candidate.path)), (workspace): HeadFacts => ({
          ...(workspace.cwd !== undefined ? { projectPath: workspace.cwd } : {}),
          ...(workspace.created_at !== undefined ? { startedAt: workspace.created_at } : {})
        })),
      follows: true,
      read: (descriptor, readOptions) =>
        Stream.concat(
          // The display name lives beside the log, not in it.
          Stream.fromEffect(readWorkspace(path.dirname(descriptor.sourcePath))).pipe(
            Stream.flatMap((workspace) => {
              const title = workspaceTitle(workspace)
              return title === undefined ? Stream.empty : Stream.succeed(Emission.metadata({ title: { value: title, priority: 20 } }))
            })
          ),
          readSession(descriptor, { _tag: "Root" }, descriptor.nativeId, readOptions)
        )
    })

    /**
     * Find a subagent in its parent's log. Only `resolve` pays for this scan: listing stays
     * a stat and a one-line head read per session, so subagents are reached through the
     * parent's `child` relationships rather than listed.
     */
    const findSubagent = (file: string, agentId: string) =>
      readLines(fs, harness, file).pipe(
        Stream.filter(({ line }) =>
          line.includes("\"subagent.started\"") || (line.includes("\"tool.execution_start\"") && line.includes("\"task\""))
        ),
        Stream.map(({ line }) => parseJson(line)),
        Stream.mapAccum(
          () => new Map<string, string | undefined>(),
          (spawners, json): readonly [Map<string, string | undefined>, ReadonlyArray<SpawnFacts>] => {
            if (Option.isNone(json) || typeof json.value !== "object" || json.value === null) return [spawners, []]
            const record = json.value as { type?: unknown; agentId?: unknown; timestamp?: unknown; data?: Record<string, unknown> }
            const data = record.data ?? {}
            const toolCallId = typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined
            if (toolCallId === undefined) return [spawners, []]
            if (record.type === "tool.execution_start") {
              const owner = typeof record.agentId === "string"
                ? record.agentId
                : typeof data["parentToolCallId"] === "string" ? data["parentToolCallId"] : undefined
              return [spawners.set(toolCallId, owner), []]
            }
            const subject = typeof record.agentId === "string" ? record.agentId : toolCallId
            if (record.type !== "subagent.started" || subject !== agentId) return [spawners, []]
            const label = data["agentDisplayName"] ?? data["agentName"]
            return [spawners, [{
              label: typeof label === "string" ? label : undefined,
              startedAt: typeof record.timestamp === "string" ? record.timestamp : undefined,
              spawner: spawners.get(toolCallId)
            }]]
          }
        ),
        Stream.runHead
      )

    const resolveSubagent = (id: SessionId, root: string, agentId: string) =>
      Effect.gen(function*() {
        const parent = yield* base.resolve(makeSessionId(HARNESS, root))
        const found = yield* findSubagent(parent.sourcePath, agentId)
        if (Option.isNone(found)) return yield* new SessionNotFound({ sessionId: id })
        const info = yield* statFile(fs, harness, parent.sourcePath)
        const { label, spawner, startedAt } = found.value
        const updatedAt = toIso(info.modifiedAt)
        const descriptor: SessionDescriptor = {
          id,
          harness,
          nativeId: `${root}/${agentId}`,
          sourcePath: parent.sourcePath,
          sizeBytes: info.sizeBytes,
          ...(parent.projectPath !== undefined ? { projectPath: parent.projectPath } : {}),
          parentSessionId: makeSessionId(HARNESS, spawner === undefined ? root : `${root}/${spawner}`),
          ...(label !== undefined ? { agentLabel: label } : {}),
          ...(startedAt !== undefined && !Number.isNaN(Date.parse(startedAt)) ? { startedAt: new Date(startedAt).toISOString() } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {})
        }
        return descriptor
      })

    const adapter: HarnessAdapterShape = {
      ...base,
      resolve: (id) => {
        const parsed = parseSessionId(id)
        if (parsed === undefined || parsed.harness !== harness) return Effect.fail(new SessionNotFound({ sessionId: id }))
        const { agentId, root } = splitNativeId(parsed.nativeId)
        return agentId === undefined || agentId.length === 0 ? base.resolve(id) : resolveSubagent(id, root, agentId)
      },
      read: (descriptor, readOptions) => {
        const { agentId, root } = splitNativeId(descriptor.nativeId)
        return agentId === undefined
          ? base.read(descriptor, readOptions)
          : readSession(descriptor, { _tag: "Agent", agentId }, root, readOptions).pipe(
            Stream.withSpan("bridge.normalize-session", { attributes: { harness } })
          )
      }
    }
    return adapter
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(CopilotAdapter, CopilotAdapter.make)
}
