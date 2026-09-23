import { Schema } from "effect"
import { HarnessId, SessionId, Timestamp } from "./ids.ts"

/** Wire protocol version. Independent from package versions (spec §72). */
export const PROTOCOL_VERSION = 1 as const

export const BridgeSessionManifest = Schema.Struct({
  format: Schema.Literal("bridge-session"),
  version: Schema.Literal(PROTOCOL_VERSION),
  sessionId: SessionId,
  harness: HarnessId,
  eventCount: Schema.Int,
  warningCount: Schema.Int,
  exportedAt: Schema.optionalKey(Timestamp)
}).pipe(Schema.annotate({ identifier: "BridgeSessionManifest", title: "Bridge session export manifest" }))
export type BridgeSessionManifest = typeof BridgeSessionManifest.Type
