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
export const ompFixtureAgentDir = `${fixturesDir}omp/agent`
export const ampFixtureDataHome = `${fixturesDir}amp/data`
export const ampFixtureExports = `${fixturesDir}amp/exports`
export const droidFixtureHome = `${fixturesDir}droid`
export const copilotFixtureHome = `${fixturesDir}copilot`
export const qwenFixtureHome = `${fixturesDir}qwen-code`
export const grokFixtureHome = `${fixturesDir}grok`
export const kimiFixtureHome = `${fixturesDir}kimi`
export const crushFixtureGlobalData = `${fixturesDir}crush/global`
export const gooseFixtureRoot = `${fixturesDir}goose`

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
  acp: "acp:claude-code-acp/sess_acp_1",
  omp: "omp:dddddddd-dddd-7ddd-8ddd-dddddddddddd",
  ompSubagent: "omp:dddddddd-dddd-7ddd-8ddd-dddddddddddd/TodoScout",
  amp: "amp:T-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ampExported: "amp:T-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  droid: "droid:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  droidSubagent: "droid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  copilot: "copilot:0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c",
  qwen: "qwen-code:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  qwenSubagent: "qwen-code:dddddddd-dddd-4ddd-8ddd-dddddddddddd/agent-explore-7f3c",
  qwenBranched: "qwen-code:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  grok: "grok:01990a00-0000-7000-8000-00000000a001",
  grokSubagent: "grok:01990a00-0000-7000-8000-00000000a002",
  kimi: "kimi:session_c0dec0de-c0de-4c0d-8c0d-c0dec0dec0de",
  kimiSubagent: "kimi:session_c0dec0de-c0de-4c0d-8c0d-c0dec0dec0de/agent-1",
  crush: "crush:c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7",
  crushSubagent: "crush:c7000000-0000-4000-8000-000000000011$$call_agent",
  goose: "goose:20260901_1",
  gooseSubagent: "goose:20260901_2",
  gooseLegacy: "goose:20250611_090000",
  gooseImported: "goose:20250520_080000"
} as const

/** Resolvable by ID but not listed: Copilot subagents live inline in the parent's log. */
export const unlistedScenario = {
  copilotSubagent: "copilot:0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c/call_task_todos"
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
    BRIDGE_ACP_RECORDINGS: acpFixtureRecordings,
    OMP_CODING_AGENT_DIR: ompFixtureAgentDir,
    AMP_DATA_HOME: ampFixtureDataHome,
    BRIDGE_AMP_EXPORTS: ampFixtureExports,
    FACTORY_HOME_OVERRIDE: droidFixtureHome,
    COPILOT_HOME: copilotFixtureHome,
    QWEN_HOME: qwenFixtureHome,
    QWEN_RUNTIME_DIR: qwenFixtureHome,
    GROK_HOME: grokFixtureHome,
    KIMI_CODE_HOME: kimiFixtureHome,
    CRUSH_GLOBAL_DATA: crushFixtureGlobalData,
    GOOSE_PATH_ROOT: gooseFixtureRoot
  }
} as const
