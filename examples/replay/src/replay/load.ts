import { Bridge, type BridgeError } from "@agentbridge/core"
import { Effect } from "effect"
import { buildReplaySession, type ReplayDerivationError } from "./derive.ts"
import type { ReplaySession } from "./model.ts"

/** Open any session through the public Bridge API and derive its Replay. */
export const loadReplaySession = (
  id: string
): Effect.Effect<ReplaySession, BridgeError | ReplayDerivationError, Bridge> =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const { session, warnings } = yield* bridge.sessions.get(id)
    return yield* buildReplaySession(session, bridge.sessions.events(id), warnings)
  })
