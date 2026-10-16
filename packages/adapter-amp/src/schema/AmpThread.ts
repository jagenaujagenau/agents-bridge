import { Schema } from "effect"

/**
 * Provider schemas for Amp threads: one pretty-printed JSON document per thread.
 *
 * - Legacy local storage (Amp CLI up to 2026-03-31): `$XDG_DATA_HOME/amp/threads/T-<uuid>.json`,
 *   rewritten in place through a `*.json.amptmp` temp file. Later versions keep threads on the
 *   server only, so these files are a frozen history.
 * - `amp threads export <id>` output saved by the user. That command prints the same thread
 *   object (`JSON.stringify(thread, null, 2)`); newer server-side threads may use `M-<base62>`
 *   message IDs and ISO `createdAt` strings, so IDs and timestamps decode leniently.
 *
 * Field names were verified against `@sourcegraph/amp` 0.0.1774959077 (`dist/main.js`): the
 * thread delta reducer, the tool specs and the DTW wire schema.
 */

const MessageId = Schema.Union([Schema.Number, Schema.String])
const Instant = Schema.Union([Schema.Number, Schema.String])

const MessageFields = {
  messageId: Schema.optionalKey(MessageId),
  content: Schema.Array(Schema.Unknown),
  createdAt: Schema.optionalKey(Instant)
}

export const AmpUserMessage = Schema.Struct({
  role: Schema.tag("user"),
  ...MessageFields,
  meta: Schema.optionalKey(Schema.Struct({ sentAt: Schema.optionalKey(Schema.Number) })),
  interrupted: Schema.optionalKey(Schema.Boolean)
})

export const AmpAssistantMessage = Schema.Struct({
  role: Schema.tag("assistant"),
  ...MessageFields,
  /** `streaming` | `complete` | `cancelled` | `error`; `complete` carries a stop reason. */
  state: Schema.optionalKey(Schema.Struct({
    type: Schema.String,
    stopReason: Schema.optionalKey(Schema.NullOr(Schema.String))
  })),
  usage: Schema.optionalKey(Schema.Unknown),
  /** Set on the last assistant message when the agent goes idle. */
  turnElapsedMs: Schema.optionalKey(Schema.Number)
})

export const AmpInfoMessage = Schema.Struct({ role: Schema.tag("info"), ...MessageFields })

export const AmpMessage = Schema.Union([AmpUserMessage, AmpAssistantMessage, AmpInfoMessage])
export type AmpMessage = typeof AmpMessage.Type

export const KNOWN_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "info"])

/** `tool_result.run` and `manual_bash_invocation.toolRun`. */
export const AmpToolRun = Schema.Struct({
  /** queued | blocked-on-user | in-progress | done | error | cancelled | rejected-by-user */
  status: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.NullOr(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))),
  progress: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.Unknown)
})
export type AmpToolRun = typeof AmpToolRun.Type

export const AmpBlock = Schema.Union([
  Schema.Struct({ type: Schema.tag("text"), text: Schema.String, hidden: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({
    type: Schema.tag("image"),
    source: Schema.optionalKey(Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
      mediaType: Schema.optionalKey(Schema.String)
    }))
  }),
  Schema.Struct({ type: Schema.tag("tool_result"), toolUseID: Schema.String, run: AmpToolRun }),
  Schema.Struct({ type: Schema.tag("thinking"), thinking: Schema.String }),
  Schema.Struct({ type: Schema.tag("redacted_thinking") }),
  Schema.Struct({
    type: Schema.tag("tool_use"),
    id: Schema.String,
    name: Schema.String,
    input: Schema.optionalKey(Schema.Unknown),
    complete: Schema.optionalKey(Schema.Boolean)
  }),
  Schema.Struct({ type: Schema.tag("server_tool_use"), id: Schema.String, name: Schema.String, input: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({
    type: Schema.tag("manual_bash_invocation"),
    args: Schema.Struct({
      cmd: Schema.String,
      args: Schema.optionalKey(Schema.Array(Schema.String)),
      cwd: Schema.optionalKey(Schema.String)
    }),
    toolRun: AmpToolRun,
    hidden: Schema.optionalKey(Schema.Boolean)
  })
])
export type AmpBlock = typeof AmpBlock.Type

export const KNOWN_BLOCKS: ReadonlySet<string> = new Set([
  "text",
  "image",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "server_tool_use",
  "manual_bash_invocation"
])

/** Per-message usage. Merged with `max()` only while the same model call streams. */
export const AmpUsage = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  cacheCreationInputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  cacheReadInputTokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  totalInputTokens: Schema.optionalKey(Schema.Number),
  timestamp: Schema.optionalKey(Schema.String)
})
export type AmpUsage = typeof AmpUsage.Type

export const AmpRelationship = Schema.Struct({
  threadID: Schema.String,
  type: Schema.String,
  /** This thread's role in the link. */
  role: Schema.optionalKey(Schema.String)
})
export type AmpRelationship = typeof AmpRelationship.Type

export const AmpEnvironment = Schema.Struct({
  initial: Schema.optionalKey(Schema.Struct({
    workspaceRoot: Schema.optionalKey(Schema.String),
    workingDirectory: Schema.optionalKey(Schema.String),
    trees: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    platform: Schema.optionalKey(Schema.Unknown),
    tags: Schema.optionalKey(Schema.Array(Schema.Unknown))
  }))
})

/** The thread document. `~debug`, `draft`, `queuedMessages` and `meta` carry no conversation facts. */
export const AmpThread = Schema.Struct({
  v: Schema.optionalKey(Schema.Number),
  id: Schema.optionalKey(Schema.String),
  created: Schema.optionalKey(Instant),
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agentMode: Schema.optionalKey(Schema.String),
  mainThreadID: Schema.optionalKey(Schema.String),
  originThreadID: Schema.optionalKey(Schema.String),
  relationships: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  env: Schema.optionalKey(Schema.Unknown),
  messages: Schema.Array(Schema.Unknown)
})
export type AmpThread = typeof AmpThread.Type
