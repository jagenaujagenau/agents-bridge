import {
  commonBinDirs,
  cacheDiscovery,
  isWithinProject,
  detectHarness,
  Emission,
  harnessRoot,
  HostEnvironment,
  type HarnessAdapterShape,
  type ReadSourceOptions,
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
import { Context, Effect, FileSystem, Layer, Option, Path, Result, Schema, Stream } from "effect"
import { FORMAT, HARNESS, initialState, normalizeLine, onHalt } from "./ClaudeCodeNormalizer.ts"
import { decodeLine } from "./ClaudeCodeSource.ts"
import { SubagentSidecar } from "./schema/ClaudeRecord.ts"

const harness = HARNESS as HarnessId

export const ClaudeCodeCapabilities = {
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

interface Candidate {
  readonly path: string
  /** Undefined for flat `agent-*.jsonl` files, whose parent is only known from their records. */
  readonly nativeId: string | undefined
  readonly parentNativeId: string | undefined
  readonly agentFile: string | undefined
  readonly sidecarPath: string | undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Map a file under `projects/` to a session candidate, or `undefined` if it is not a session. */
export const classifyProjectFile = (relativeParts: ReadonlyArray<string>, absolute: string): Candidate | undefined => {
  const file = relativeParts[relativeParts.length - 1]
  if (file === undefined || !file.endsWith(".jsonl")) return undefined
  if (relativeParts.includes("memory")) return undefined
  const stem = file.slice(0, -".jsonl".length)
  const sidecar = absolute.slice(0, -".jsonl".length) + ".meta.json"

  if (relativeParts.length === 2) {
    if (stem.startsWith("agent-")) {
      return { path: absolute, nativeId: undefined, parentNativeId: undefined, agentFile: stem, sidecarPath: sidecar }
    }
    return { path: absolute, nativeId: stem, parentNativeId: undefined, agentFile: undefined, sidecarPath: undefined }
  }

  // <project>/<parent-uuid>/subagents/[workflows/<wf>/]agent-<id>.jsonl
  const [, parent, marker, ...rest] = relativeParts
  if (parent === undefined || marker !== "subagents" || !UUID.test(parent) || rest.length === 0) return undefined
  if (file === "journal.jsonl" || !stem.startsWith("agent-")) return undefined
  const suffix = [...rest.slice(0, -1), stem].join("/")
  return {
    path: absolute,
    nativeId: `${parent}/${suffix}`,
    parentNativeId: parent,
    agentFile: stem,
    sidecarPath: sidecar
  }
}

const HeadRecord = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.String)
})
const decodeHead = Schema.decodeUnknownOption(HeadRecord)

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCodeAdapter extends Context.Service<ClaudeCodeAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-claude-code/ClaudeCodeAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const detectContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | HostEnvironment | VersionProbe>()
    // CLAUDE_CONFIG_DIR replaces ~/.claude.
    const configDir = yield* harnessRoot("CLAUDE_CONFIG_DIR", ".claude")
    const projectsDir = path.join(configDir, "projects")

    const detect: Effect.Effect<DetectionResult> = detectHarness({
      harness,
      name: "Claude Code",
      executables: ["claude"],
      extraDirs: [...(host.home ? [path.join(host.home, ".claude", "local")] : []), ...commonBinDirs(path, host.home)],
      historyPaths: [projectsDir]
    }).pipe(Effect.provideContext(detectContext))

    const candidates = Effect.gen(function*() {
      const files = yield* listFilesRecursive(fs, path, harness, projectsDir)
      return files.flatMap((absolute) => {
        const relative = path.relative(projectsDir, absolute).split(path.sep)
        const candidate = classifyProjectFile(relative, absolute)
        return candidate ? [candidate] : []
      })
    })

    const discovery = yield* cacheDiscovery(candidates)

    const describe = (candidate: Candidate): Effect.Effect<Option.Option<SessionDescriptor>, SessionReadError> =>
      Effect.gen(function*() {
        const info = yield* statFile(fs, harness, candidate.path)
        const head = yield* readHeadLines(fs, harness, candidate.path, 25)
        let cwd: string | undefined
        let startedAt: string | undefined
        let recordSessionId: string | undefined
        for (const line of head) {
          const record = Option.flatMap(parseJson(line), decodeHead)
          if (Option.isNone(record)) continue
          cwd ??= record.value.cwd
          startedAt ??= record.value.timestamp
          recordSessionId ??= record.value.sessionId
        }
        // Flat agent files carry the parent's sessionId in every record; never bind it as their own.
        const parentNativeId = candidate.parentNativeId ??
          (candidate.agentFile !== undefined ? recordSessionId : undefined)
        const nativeId = candidate.nativeId ??
          (parentNativeId !== undefined ? `${parentNativeId}/${candidate.agentFile}` : undefined)
        if (nativeId === undefined) return Option.none()

        const sidecar = candidate.sidecarPath === undefined
          ? Option.none()
          : yield* fs.readFileString(candidate.sidecarPath).pipe(
            Effect.map((text) => Option.flatMap(parseJson(text), Schema.decodeUnknownOption(SubagentSidecar))),
            Effect.orElseSucceed(() => Option.none())
          )
        const agentLabel = Option.getOrUndefined(Option.flatMapNullishOr(sidecar, (s) => s.agentType)) ??
          candidate.agentFile
        const updatedAt = toIso(info.modifiedAt)
        const descriptor: SessionDescriptor = {
          id: makeSessionId(HARNESS, nativeId),
          harness,
          nativeId,
          sourcePath: candidate.path,
          sizeBytes: info.sizeBytes,
          ...(cwd !== undefined ? { projectPath: cwd } : {}),
          ...(parentNativeId !== undefined ? { parentSessionId: makeSessionId(HARNESS, parentNativeId) } : {}),
          ...(parentNativeId !== undefined && agentLabel !== undefined ? { agentLabel } : {}),
          ...(startedAt !== undefined && !Number.isNaN(Date.parse(startedAt)) ? { startedAt } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {})
        }
        return Option.some(descriptor)
      })

    const listSessions = (options?: ListSessionsOptions) =>
      Stream.fromEffect(options?.refresh ? discovery.refresh : discovery.get).pipe(
        Stream.flatMap((all) => Stream.fromIterable(all)),
        Stream.mapEffect(describe, { concurrency: 8 }),
        Stream.filterMap((descriptor) => Result.fromOption(descriptor, () => undefined)),
        Stream.filter((d) =>
          (options?.since === undefined || (d.updatedAt !== undefined && Date.parse(d.updatedAt) >= options.since.getTime())) &&
          (options?.projectPath === undefined || isWithinProject(path, d.projectPath, options.projectPath))
        )
      )

    const resolve = (id: SessionId) =>
      Effect.gen(function*() {
        const parsed = parseSessionId(id)
        if (parsed === undefined || parsed.harness !== harness) return yield* new SessionNotFound({ sessionId: id })
        const last = parsed.nativeId.split("/").pop()
        const all = yield* discovery.get
        for (const candidate of all) {
          const plausible = candidate.nativeId === parsed.nativeId ||
            (candidate.nativeId === undefined && candidate.agentFile === last)
          if (!plausible) continue
          const descriptor = yield* describe(candidate)
          if (Option.isSome(descriptor) && descriptor.value.id === id) return descriptor.value
        }
        return yield* new SessionNotFound({ sessionId: id })
      })

    const sidecarMetadata = (descriptor: SessionDescriptor) => {
      const sidecarPath = descriptor.sourcePath.replace(/\.jsonl$/, ".meta.json")
      if (descriptor.parentSessionId === undefined) return Stream.empty
      return Stream.fromEffect(
        fs.readFileString(sidecarPath).pipe(
          Effect.map((text) => Option.flatMap(parseJson(text), Schema.decodeUnknownOption(SubagentSidecar))),
          Effect.orElseSucceed(() => Option.none())
        )
      ).pipe(
        Stream.filterMap((sidecar) =>
          Result.fromOption(
            Option.flatMapNullishOr(sidecar, (s) => s.description).pipe(
              Option.map((description) => Emission.metadata({ title: { value: description, priority: 50 } }))
            ),
            () => undefined
          )
        )
      )
    }

    const read = (descriptor: SessionDescriptor, readOptions?: ReadSourceOptions): Stream.Stream<Emission, SessionReadError> =>
      Stream.concat(
        sidecarMetadata(descriptor),
        readLines(fs, harness, descriptor.sourcePath, { follow: readOptions?.follow }).pipe(
          Stream.map(decodeLine),
          Stream.mapAccum(
            () => initialState(descriptor.id, descriptor.sourcePath),
            normalizeLine,
            { onHalt }
          )
        )
      ).pipe(Stream.withSpan("bridge.normalize-session", { attributes: { harness, format: FORMAT } }))

    const adapter: HarnessAdapterShape = {
      follows: true,
      id: harness,
      name: "Claude Code",
      capabilities: ClaudeCodeCapabilities,
      detect,
      listSessions,
      resolve: (id) => resolve(id).pipe(Effect.catchTag("SessionNotFound", () => Effect.andThen(discovery.invalidate, resolve(id)))),
      read
    }
    return adapter
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(ClaudeCodeAdapter, ClaudeCodeAdapter.make)
}
