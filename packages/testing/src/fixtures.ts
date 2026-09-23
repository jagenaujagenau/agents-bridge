import { Bridge, type HarnessAdapterShape, HarnessRegistry, VersionProbe } from "@agentbridge/core"
import { MemorySessionStore } from "@agentbridge/store-memory"
import { NodeServices } from "@effect/platform-node"
import { type Context, Effect, type FileSystem, Layer, type Path } from "effect"
import { fileURLToPath } from "node:url"

/** Sanitized native histories checked into the repository (spec §61). */
export const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url))
export const claudeFixtureDir = `${fixturesDir}claude`
export const codexFixtureHome = `${fixturesDir}codex`
export const piFixtureAgentDir = `${fixturesDir}pi`
export const openCodeFixtureDataDir = `${fixturesDir}opencode`
export const geminiFixtureHome = `${fixturesDir}gemini-cli`
export const cursorFixtureDir = `${fixturesDir}cursor`
export const antigravityFixtureHome = `${fixturesDir}antigravity`
export const acpFixtureRecordings = `${fixturesDir}acp`

/** The §63 scenario recorded by each harness. */
export const scenario = {
  claude: "claude-code:11111111-1111-4111-8111-111111111111",
  claudeSubagent: "claude-code:11111111-1111-4111-8111-111111111111/agent-a1b2c3",
  codex: "codex:22222222-2222-4222-8222-222222222222",
  codexSubagent: "codex:33333333-3333-4333-8333-333333333333",
  pi: "pi:55555555-5555-4555-8555-555555555555",
  piSubagent: "pi:66666666-6666-4666-8666-666666666666",
  piBranched: "pi:67676767-6767-4767-8767-676767676767",
  opencode: "opencode:ses_77777777parent",
  opencodeSubagent: "opencode:ses_88888888child",
  gemini: "gemini-cli:2026-09-01T10-00-99999999",
  cursor: "cursor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cursorSubagent: "cursor:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  antigravity: "antigravity:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  acp: "acp:claude-code-acp/sess_acp_1"
} as const

type AdapterRequirements<Config> = Config | VersionProbe | FileSystem.FileSystem | Path.Path

/**
 * A Bridge over a single adapter service with the in-memory store, a no-op
 * version probe and Node platform services.
 */
export const bridgeWithAdapter = <Self, Config>(
  service: Context.Key<Self, HarnessAdapterShape>,
  adapterLayer: Layer.Layer<Self, never, AdapterRequirements<Config>>,
  configLayer: Layer.Layer<Config>
): Layer.Layer<Bridge> =>
  Bridge.layer.pipe(
    Layer.provide(Layer.mergeAll(HarnessRegistry.layer([Effect.service(service)]), MemorySessionStore.layer)),
    Layer.provide(adapterLayer),
    Layer.provide(Layer.mergeAll(configLayer, VersionProbe.layerNoop)),
    Layer.provide(NodeServices.layer)
  )

/**
 * `NodeBridge.layer` options that point every harness at the fixtures and
 * nothing at the machine running the tests.
 */
export const fixtureBridgeOptions = {
  probeVersions: false,
  environment: {
    CLAUDE_CONFIG_DIR: claudeFixtureDir,
    CODEX_HOME: codexFixtureHome,
    HOME: "/nonexistent-home",
    PATH: "",
    PI_CODING_AGENT_DIR: piFixtureAgentDir,
    OPENCODE_DATA_DIR: openCodeFixtureDataDir,
    GEMINI_CLI_HOME: geminiFixtureHome,
    CURSOR_CONFIG_DIR: cursorFixtureDir,
    ANTIGRAVITY_HOME: antigravityFixtureHome,
    BRIDGE_ACP_RECORDINGS: acpFixtureRecordings
  }
} as const
