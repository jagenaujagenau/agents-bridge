import type {
  DetectionResult,
  HarnessCapabilities,
  HarnessId,
  SessionDescriptor,
  SessionId
} from "@agentbridge/schema"
import type { Duration, Effect, Stream } from "effect"
import type { SessionNotFound, SessionReadError } from "./errors.ts"
import type { Emission } from "./normalize.ts"

export interface ListSessionsOptions {
  /** Only sessions whose source was modified at or after this instant. */
  readonly since?: Date | undefined
  /** Only sessions in this project directory or its descendants. */
  readonly projectPath?: string | undefined
  /** Refresh the short-lived file discovery cache before listing. */
  readonly refresh?: boolean | undefined
}

/**
 * What every harness adapter implements. Adapters produce *emissions*
 * (events, warnings, metadata); Bridge Core turns them into sequenced events
 * and loaded sessions, so that logic is shared rather than re-implemented.
 */
export interface HarnessAdapterShape {
  readonly id: HarnessId
  readonly name: string
  /** Static baseline of what this adapter implements. */
  readonly capabilities: HarnessCapabilities
  /** Never fails: problems probing individual signals become `notes`. */
  readonly detect: Effect.Effect<DetectionResult>
  /** Cheap listing. Must not fully parse history files. */
  readonly listSessions: (options?: ListSessionsOptions) => Stream.Stream<SessionDescriptor, SessionReadError>
  /** Locate one session by canonical ID without listing everything when possible. */
  readonly resolve: (id: SessionId) => Effect.Effect<SessionDescriptor, SessionNotFound | SessionReadError>
  /**
   * Stream normalized emissions for one session, in source order. With `follow`, adapters
   * that set `follows` keep reading appended data until interrupted.
   */
  readonly read: (session: SessionDescriptor, options?: ReadSourceOptions) => Stream.Stream<Emission, SessionReadError>
  /** `read` honors `follow` (append-only line sources). Others are watched by re-reading. */
  readonly follows?: boolean | undefined
}

export interface ReadSourceOptions {
  /** Keep reading appended data, polling at this interval. */
  readonly follow?: Duration.Input | undefined
}
