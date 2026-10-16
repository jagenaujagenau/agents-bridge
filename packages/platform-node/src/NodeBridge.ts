import { AcpRecordingAdapter } from "@agentbridge/adapter-acp"
import { AmpAdapter } from "@agentbridge/adapter-amp"
import { AntigravityAdapter } from "@agentbridge/adapter-antigravity"
import { ClaudeCodeAdapter } from "@agentbridge/adapter-claude-code"
import { CodexAdapter } from "@agentbridge/adapter-codex"
import { CopilotAdapter } from "@agentbridge/adapter-copilot"
import { CursorAdapter } from "@agentbridge/adapter-cursor"
import { DroidAdapter } from "@agentbridge/adapter-droid"
import { GeminiCliAdapter } from "@agentbridge/adapter-gemini-cli"
import { OmpAdapter } from "@agentbridge/adapter-omp"
import { OpenCodeAdapter } from "@agentbridge/adapter-opencode"
import { PiAdapter } from "@agentbridge/adapter-pi"
import { QwenCodeAdapter } from "@agentbridge/adapter-qwen-code"
import { GrokAdapter } from "@agentbridge/adapter-grok"
import { KimiAdapter } from "@agentbridge/adapter-kimi"
import { CrushAdapter } from "@agentbridge/adapter-crush"
import { GooseAdapter } from "@agentbridge/adapter-goose"
import {
  Bridge,
  type HarnessAdapterShape,
  HarnessRegistry,
  HostEnvironment,
  parseVersionOutput,
  VersionProbe
} from "@agentbridge/core"
import { MemorySessionStore } from "@agentbridge/store-memory"
import { SqliteSessionStore } from "@agentbridge/store-sqlite"
import { NodeServices } from "@effect/platform-node"
import { Duration, Effect, Layer, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodeGitRepository } from "./NodeGitRepository.ts"
import { NodeSqliteReader } from "./NodeSqliteReader.ts"

/** Runs `<binary> --version` with a short timeout. Any failure means "version unknown". */
export const NodeVersionProbe = Layer.effect(
  VersionProbe,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return {
      probe: (executable, args) =>
        spawner.string(ChildProcess.make(executable, [...args])).pipe(
          Effect.map(parseVersionOutput),
          Effect.timeoutOption(Duration.seconds(5)),
          Effect.map(Option.flatten),
          Effect.orElseSucceed(() => Option.none<string>())
        )
    }
  })
)

type AdapterServices =
  | ClaudeCodeAdapter
  | CodexAdapter
  | OpenCodeAdapter
  | PiAdapter
  | GeminiCliAdapter
  | CursorAdapter
  | AntigravityAdapter
  | AcpRecordingAdapter
  | OmpAdapter
  | AmpAdapter
  | DroidAdapter
  | CopilotAdapter
  | QwenCodeAdapter
  | GrokAdapter
  | KimiAdapter
  | CrushAdapter
  | GooseAdapter

const adapterServices: Record<string, Effect.Effect<HarnessAdapterShape, never, AdapterServices>> = {
  "claude-code": Effect.service(ClaudeCodeAdapter),
  codex: Effect.service(CodexAdapter),
  opencode: Effect.service(OpenCodeAdapter),
  pi: Effect.service(PiAdapter),
  "gemini-cli": Effect.service(GeminiCliAdapter),
  cursor: Effect.service(CursorAdapter),
  antigravity: Effect.service(AntigravityAdapter),
  acp: Effect.service(AcpRecordingAdapter),
  omp: Effect.service(OmpAdapter),
  amp: Effect.service(AmpAdapter),
  droid: Effect.service(DroidAdapter),
  copilot: Effect.service(CopilotAdapter),
  "qwen-code": Effect.service(QwenCodeAdapter),
  grok: Effect.service(GrokAdapter),
  kimi: Effect.service(KimiAdapter),
  crush: Effect.service(CrushAdapter),
  goose: Effect.service(GooseAdapter)
}

export const HarnessAdapterIds = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
  "gemini-cli",
  "cursor",
  "antigravity",
  "acp",
  "omp",
  "amp",
  "droid",
  "copilot",
  "qwen-code",
  "grok",
  "kimi",
  "crush",
  "goose"
] as const
export type HarnessAdapterId = (typeof HarnessAdapterIds)[number]

export interface NodeBridgeOptions {
  /** Adapters to register. Defaults to all. */
  readonly adapters?: ReadonlyArray<HarnessAdapterId> | undefined
  /** Probe installed binaries for their version during detection. Defaults to true. */
  readonly probeVersions?: boolean | undefined
  /**
   * Environment variables to override, e.g. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or
   * `OPENCODE_DATA_DIR`. Variables not listed fall back to the process environment.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** SQLite file for the session store (opened on first use). Defaults to an in-memory store. */
  readonly database?: string | undefined
}

/**
 * Batteries-included Node runtime: every adapter, a session store (in-memory or
 * SQLite) and Node platform services, composed only from public Layers.
 */
export const layer = (options: NodeBridgeOptions = {}) => {
  const selected = options.adapters ?? HarnessAdapterIds
  const adapters = selected.map((id) => adapterServices[id]!)
  const host = HostEnvironment.layerWithOverrides(options.environment ?? {})
  const probe = options.probeVersions === false ? VersionProbe.layerNoop : NodeVersionProbe
  const adapterLayers = Layer.mergeAll(
    ClaudeCodeAdapter.layer,
    CodexAdapter.layer,
    OpenCodeAdapter.layer,
    PiAdapter.layer,
    GeminiCliAdapter.layer,
    CursorAdapter.layer,
    AntigravityAdapter.layer,
    AcpRecordingAdapter.layer,
    OmpAdapter.layer,
    AmpAdapter.layer,
    DroidAdapter.layer,
    CopilotAdapter.layer,
    QwenCodeAdapter.layer,
    GrokAdapter.layer,
    KimiAdapter.layer,
    CrushAdapter.layer,
    GooseAdapter.layer
  )
    .pipe(Layer.provide(Layer.mergeAll(probe, host, NodeSqliteReader)))
  return Bridge.layer.pipe(
    Layer.provide(Layer.mergeAll(
      HarnessRegistry.layer(adapters),
      NodeGitRepository,
      options.database === undefined ? MemorySessionStore.layer : SqliteSessionStore.layer(options.database)
    )),
    Layer.provide(adapterLayers),
    Layer.provideMerge(NodeServices.layer)
  )
}
