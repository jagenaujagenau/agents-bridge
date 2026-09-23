import {
  type Emission,
  type HarnessAdapterShape,
  harnessRoot,
  HostEnvironment,
  makeFileHistoryAdapter,
  parseJson,
  readLines,
  sequenceEvents,
  stringProp
} from "@agentbridge/core"
import { type HarnessId, noCapabilities, type SessionEvent } from "@agentbridge/schema"
import { Context, Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import {
  type AcpEnvelope,
  acpSessionId,
  HARNESS,
  initialState,
  MALFORMED_JSON,
  NAME,
  normalizeEnvelope,
  onHalt
} from "./AcpNormalizer.ts"

export interface AcpStreamOptions {
  /** Identifies the agent behind the connection, e.g. `gemini` or `claude-code-acp`. */
  readonly agent: string
  /** The ACP session to normalize; traffic for other sessions is ignored. */
  readonly sessionId: string
  /** Provenance recorded on every event, e.g. a recording path or connection label. */
  readonly source?: string | undefined
}

/** A recorded message: either a bare JSON-RPC message or `{receivedAt, message}`. */
const toEnvelope = (item: unknown, index: number): AcpEnvelope => {
  if (typeof item === "object" && item !== null && "message" in item && !("jsonrpc" in item)) {
    const receivedAt = stringProp(item, "receivedAt")
    return { index, message: (item as { message: unknown }).message, ...(receivedAt ? { receivedAt } : {}) }
  }
  return { index, message: item }
}

/**
 * Normalize a live or recorded stream of ACP messages into Bridge emissions.
 * Bridge does not own the connection: pass it whatever your ACP client observes.
 */
export const acpEmissions = (options: AcpStreamOptions) =>
<E, R>(messages: Stream.Stream<unknown, E, R>): Stream.Stream<Emission, E, R> =>
  messages.pipe(
    Stream.zipWithIndex,
    Stream.map(([item, index]) => toEnvelope(item, index)),
    Stream.mapAccum(
      () => initialState({ agent: options.agent, sessionId: options.sessionId, source: options.source ?? "acp-stream" }),
      normalizeEnvelope,
      { onHalt }
    )
  )

/** The canonical event stream for one ACP session: the same `SessionEvent`s historical adapters produce. */
export const acpEvents = (options: AcpStreamOptions) =>
<E, R>(messages: Stream.Stream<unknown, E, R>): Stream.Stream<SessionEvent, E, R> =>
  acpEmissions(options)(messages).pipe(sequenceEvents(acpSessionId(options.agent, options.sessionId)))

export const AcpCapabilities = {
  ...noCapabilities,
  historicalSessions: true,
  reasoning: true,
  toolCalls: true,
  toolResults: true,
  commandEvents: true,
  fileEvents: true
}

/** `<agent>/<acp session id>.jsonl` */
export const classifyRecording = (parts: ReadonlyArray<string>, absolute: string) => {
  const [agent, file] = parts
  if (parts.length !== 2 || agent === undefined || file === undefined || !file.endsWith(".jsonl")) return undefined
  return { path: absolute, nativeId: `${agent}/${file.slice(0, -".jsonl".length)}` }
}

/**
 * Historical access to recorded ACP traffic, one JSONL file per session under
 * `$BRIDGE_ACP_RECORDINGS/<agent>/<session id>.jsonl` (default `~/.bridge/acp`).
 */
export class AcpRecordingAdapter extends Context.Service<AcpRecordingAdapter, HarnessAdapterShape>()(
  "@agentbridge/adapter-acp/AcpRecordingAdapter"
) {
  static readonly make = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const host = yield* HostEnvironment
    const override = yield* host.variable("BRIDGE_ACP_RECORDINGS")
    const root = override ?? (yield* harnessRoot("BRIDGE_HOME", ".bridge").pipe(Effect.map((dir) => path.join(dir, "acp"))))
    const harness = HARNESS as HarnessId

    return yield* makeFileHistoryAdapter({
      id: harness,
      name: NAME,
      capabilities: AcpCapabilities,
      detect: { executables: [], extraDirs: [], historyPaths: [root] },
      roots: [root],
      classify: classifyRecording,
      headLines: 1,
      inspect: (head) => {
        const first = Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(head[0]), parseJson))
        return { startedAt: stringProp(first, "receivedAt") }
      },
      read: (descriptor) => {
        const [agent, ...rest] = descriptor.nativeId.split("/")
        const options = { agent: agent!, sessionId: rest.join("/"), source: descriptor.sourcePath }
        return readLines(fs, harness, descriptor.sourcePath).pipe(
          Stream.filter(({ line }) => line.trim().length > 0),
          Stream.map(({ line }) => Option.getOrElse(parseJson(line), (): unknown => MALFORMED_JSON)),
          acpEmissions(options)
        )
      }
    })
  })

  /** Requires `HostEnvironment`, `VersionProbe`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(AcpRecordingAdapter, AcpRecordingAdapter.make)
}
