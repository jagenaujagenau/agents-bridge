import { Schema } from "effect"
import { HarnessId } from "./ids.ts"

/**
 * What an adapter implements. Every field defaults to `false` via
 * `noCapabilities`, so an adapter only claims what it actually does.
 */
export const HarnessCapabilities = Schema.Struct({
  historicalSessions: Schema.Boolean,
  liveSessions: Schema.Boolean,
  resumableSessions: Schema.Boolean,
  reasoning: Schema.Boolean,
  toolCalls: Schema.Boolean,
  /** Tool outcomes are recorded. Without it, tool calls, commands and file effects have no completion. */
  toolResults: Schema.Boolean,
  commandEvents: Schema.Boolean,
  fileEvents: Schema.Boolean,
  tokenUsage: Schema.Boolean,
  subagents: Schema.Boolean
}).pipe(Schema.annotate({ identifier: "HarnessCapabilities" }))
export type HarnessCapabilities = typeof HarnessCapabilities.Type

export const noCapabilities: HarnessCapabilities = {
  historicalSessions: false,
  liveSessions: false,
  resumableSessions: false,
  reasoning: false,
  toolCalls: false,
  toolResults: false,
  commandEvents: false,
  fileEvents: false,
  tokenUsage: false,
  subagents: false
}

export const DetectionResult = Schema.Struct({
  harness: HarnessId,
  name: Schema.String,
  installed: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
  historyAvailable: Schema.Boolean,
  paths: Schema.Array(Schema.String),
  /** Non-fatal problems met while probing individual detection signals. */
  notes: Schema.Array(Schema.String)
}).pipe(Schema.annotate({ identifier: "DetectionResult" }))
export type DetectionResult = typeof DetectionResult.Type
