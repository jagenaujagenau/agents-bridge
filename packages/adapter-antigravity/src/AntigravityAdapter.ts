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
import { Context, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { decodeLine, HARNESS, initialState, NAME, normalizeLine } from "./AntigravityNormalizer.ts"

const harness = HARNESS as HarnessId

export const AntigravityCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true
}

const TRANSCRIPTS: Record<string, number> = { "transcript_full.jsonl": 2, "transcript.jsonl": 1 }

/** `<conversation>/.system_generated/logs/transcript[_full].jsonl` */
export const classifyAntigravityFile = (parts: ReadonlyArray<string>, absolute: string): FileCandidate | undefined => {
  const [conversation, generated, logs, file] = parts
  if (parts.length !== 4 || generated !== ".system_generated" || logs !== "logs") return undefined
  if (conversation === undefined || file === undefined || TRANSCRIPTS[file] === undefined) return undefined
  return { path: absolute, nativeId: conversation }
}

export class AntigravityAdapter extends Context.Service<AntigravityAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-antigravity/AntigravityAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const geminiDir = yield* harnessRoot("ANTIGRAVITY_HOME", ".gemini")
    // The IDE and the CLI keep separate brains.
    const roots = ["antigravity", "antigravity-cli"].map((dir) => path.join(geminiDir, dir, "brain"))

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: AntigravityCapabilities,
      detect: {
        executables: ["antigravity", "agy"],
        extraDirs: [...commonBinDirs(path, host.home), "/Applications/Antigravity.app/Contents/Resources/app/bin"],
        historyPaths: roots
      },
      roots,
      classify: classifyAntigravityFile,
      priority: (candidate) => TRANSCRIPTS[path.basename(candidate.path)] ?? 0,
      headLines: 1,
      inspect: (head) => {
        const first = Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(head[0]), parseJson))
        return { startedAt: stringProp(first, "created_at") }
      },
      follows: true,
      read: (descriptor, readOptions) =>
        readLines(fs, harness, descriptor.sourcePath, { follow: readOptions?.follow }).pipe(
          Stream.map(decodeLine),
          Stream.mapAccum(() => initialState(descriptor.id, descriptor.sourcePath), normalizeLine)
        )
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(AntigravityAdapter, AntigravityAdapter.make)
}
