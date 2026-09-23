import { type DetectionResult, parseSessionId, type SessionDescriptor, type SessionId } from "@agentbridge/schema"
import { Context, Effect, Layer, Stream } from "effect"
import { AdapterUnavailable, SessionNotFound, type SessionReadError } from "./errors.ts"
import type { HarnessAdapterShape, ListSessionsOptions } from "./HarnessAdapter.ts"

export interface HarnessRegistryShape {
  readonly adapters: ReadonlyArray<HarnessAdapterShape>
  readonly get: (harness: string) => Effect.Effect<HarnessAdapterShape, AdapterUnavailable>
  readonly forSession: (id: string) => Effect.Effect<HarnessAdapterShape, AdapterUnavailable | SessionNotFound>
  readonly detect: Effect.Effect<ReadonlyArray<DetectionResult>>
  readonly listSessions: (
    options?: ListSessionsOptions & { readonly harness?: string | undefined }
  ) => Stream.Stream<SessionDescriptor, SessionReadError | AdapterUnavailable>
}

export class HarnessRegistry extends Context.Service<HarnessRegistry, HarnessRegistryShape>()(
  "@agentbridge/core/HarnessRegistry"
) {
  /** Build a registry from adapter services, e.g. `HarnessRegistry.layer([ClaudeCodeAdapter, CodexAdapter])`. */
  static readonly layer = <R>(
    adapters: ReadonlyArray<Effect.Effect<HarnessAdapterShape, never, R>>
  ): Layer.Layer<HarnessRegistry, never, R> =>
    Layer.effect(HarnessRegistry, Effect.map(Effect.all(adapters), makeRegistry))

  static readonly fromAdapters = (adapters: ReadonlyArray<HarnessAdapterShape>): Layer.Layer<HarnessRegistry> =>
    Layer.succeed(HarnessRegistry, makeRegistry(adapters))
}

export const makeRegistry = (adapters: ReadonlyArray<HarnessAdapterShape>): HarnessRegistryShape => {
  const byId = new Map(adapters.map((adapter) => [adapter.id as string, adapter]))

  const get = (harness: string) => {
    const adapter = byId.get(harness)
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(
        new AdapterUnavailable({
          harness,
          message: `No adapter registered for "${harness}". Registered: ${[...byId.keys()].join(", ") || "none"}`
        })
      )
  }

  const forSession = (id: string) => {
    const parsed = parseSessionId(id)
    return parsed ? get(parsed.harness) : Effect.fail(new SessionNotFound({ sessionId: id }))
  }

  const detect = Effect.forEach(adapters, (adapter) => adapter.detect, { concurrency: "unbounded" }).pipe(
    Effect.withSpan("bridge.detect-harnesses")
  )

  const listSessions = (options?: ListSessionsOptions & { readonly harness?: string | undefined }) => {
    const selected = options?.harness === undefined
      ? Stream.fromIterable(adapters)
      : Stream.fromEffect(get(options.harness))
    // Suspended so each run of the stream deduplicates with its own set.
    return Stream.suspend(() => {
      const seen = new Set<SessionId>()
      return selected.pipe(
        Stream.flatMap((adapter) => adapter.listSessions(options), { concurrency: 2 }),
        Stream.filter((descriptor) => {
          if (seen.has(descriptor.id)) return false
          seen.add(descriptor.id)
          return true
        })
      )
    })
  }

  return { adapters, get, forSession, detect, listSessions }
}
