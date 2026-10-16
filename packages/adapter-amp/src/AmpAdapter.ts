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
import { type HarnessId, noCapabilities } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { FORMAT, HARNESS, headerEmissions, initialState, instant, NAME, normalizeMessage, threadFacts } from "./AmpNormalizer.ts"
import { AmpThread } from "./schema/AmpThread.ts"

const harness = HARNESS as HarnessId

export const AmpCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true,
  tokenUsage: true
}

/** Amp refuses to load thread files larger than this. */
export const MAX_THREAD_BYTES = 50 * 1024 * 1024

const THREAD_FILE = /^(T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i

/** `threads/T-<uuid>.json`. In-flight `*.json.amptmp` rewrites are not sessions. */
export const classifyThreadFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  const [file] = parts
  if (parts.length !== 1 || file === undefined) return undefined
  const match = THREAD_FILE.exec(file)
  return match ? { path: absolute, nativeId: match[1] } : undefined
}

/** Exports keep any `*.json` name; the thread ID then comes from the document head. */
export const classifyExportFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  const [file] = parts
  if (parts.length !== 1 || file === undefined || !file.endsWith(".json")) return undefined
  return { path: absolute, nativeId: THREAD_FILE.exec(file)?.[1] }
}

/**
 * Cheap facts from the first lines of a pretty-printed thread. Amp creates threads as
 * `{v, id, created, messages}`, so `id` and `created` precede the message list.
 */
export const inspectHead = (head: ReadonlyArray<string>) => {
  const text = head.join("\n")
  const id = /"id"\s*:\s*"(T-[^"]+)"/.exec(text)?.[1]
  const created = /"created"\s*:\s*(\d{10,})/.exec(text)?.[1]
  return { nativeId: id, startedAt: created === undefined ? undefined : instant(Number(created)) }
}

const decodeThread = Schema.decodeUnknownOption(AmpThread)

/**
 * Amp threads from two roots:
 *
 * - the legacy local store `$AMP_DATA_HOME/threads` (default `$XDG_DATA_HOME/amp`, else
 *   `~/.local/share/amp`), written by Amp CLI versions up to 2026-03-31;
 * - `$BRIDGE_AMP_EXPORTS` (default `~/.bridge/amp`): threads saved with `amp threads export <id>`.
 *
 * Nothing else under the Amp data or config directories (secrets, history, settings) is read.
 */
export class AmpAdapter extends Context.Service<AmpAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-amp/AmpAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const dataHome = (yield* host.variable("XDG_DATA_HOME")) || path.join(host.home ?? ".", ".local", "share")
    const ampData = (yield* host.variable("AMP_DATA_HOME")) || path.join(dataHome, "amp")
    const threadsDir = path.join(ampData, "threads")
    const exportsDir = (yield* host.variable("BRIDGE_AMP_EXPORTS")) ||
      (yield* harnessRoot("BRIDGE_HOME", ".bridge").pipe(Effect.map((dir) => path.join(dir, "amp"))))
    const isExport = (candidate: FileCandidate) => candidate.path.startsWith(exportsDir + path.sep)

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: AmpCapabilities,
      detect: {
        executables: ["amp"],
        extraDirs: [...commonBinDirs(path, host.home), ...(host.home === undefined ? [] : [path.join(host.home, ".amp", "bin")])],
        historyPaths: [threadsDir, exportsDir]
      },
      roots: [threadsDir, exportsDir],
      classify: (parts, absolute, root) =>
        root === exportsDir ? classifyExportFile(parts, absolute) : classifyThreadFile(parts, absolute),
      headLines: 6,
      inspect: (head) => inspectHead(head),
      // A thread the user exported is the server copy, at least as recent as the frozen local file.
      priority: (candidate) => (isExport(candidate) ? 1 : 0),
      read: (descriptor) =>
        Stream.unwrap(
          Effect.gen(function*() {
            const source = { provider: HARNESS, format: FORMAT, path: descriptor.sourcePath }
            if ((descriptor.sizeBytes ?? 0) > MAX_THREAD_BYTES) {
              return Stream.succeed(Emission.warning({
                code: "source_too_large",
                message: `Skipped an ${NAME} thread larger than ${MAX_THREAD_BYTES / 1024 / 1024} MB, which Amp itself does not load`,
                source
              }))
            }
            const text = yield* fs.readFileString(descriptor.sourcePath).pipe(
              Effect.mapError((cause) =>
                new SessionReadError({ harness, path: descriptor.sourcePath, message: describeCause(cause) })
              )
            )
            const thread = Option.getOrUndefined(Option.flatMap(parseJson(text), decodeThread))
            if (thread === undefined) {
              return Stream.succeed(Emission.warning({
                code: "malformed_json",
                message: `The file is not a valid ${NAME} thread`,
                source
              }))
            }
            const facts = threadFacts(thread, descriptor.id)
            const state = initialState(descriptor.id, descriptor.sourcePath, facts.projectPath ?? descriptor.projectPath)
            return Stream.concat(
              Stream.fromIterable(headerEmissions(state, thread, facts)),
              Stream.fromIterable(thread.messages.map((message, index) => [message, index] as const)).pipe(
                Stream.mapAccum(() => state, normalizeMessage)
              )
            )
          })
        )
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(AmpAdapter, AmpAdapter.make)
}
