import {
  type EventDraft,
  type EventId,
  type HarnessIdentity,
  type ImportWarning,
  type Session,
  type SessionCapabilities,
  type SessionDescriptor,
  type SessionEvent,
  type SessionId,
  type SessionRelationship,
  type SourceReference,
  stableEventId,
  isTimestamp
} from "@agentbridge/schema"
import { Effect, Stream } from "effect"

// ---------------------------------------------------------------------------
// Emissions: what an adapter's normalizer produces
// ---------------------------------------------------------------------------

/** An event with identity assigned but not yet sequenced. */
export type IdentifiedDraft = EventDraft & { readonly id: EventId }

/** Session-level facts discovered while reading. Later patches win, except titles, which win by priority. */
export interface MetadataPatch {
  readonly title?: { readonly value: string; readonly priority: number }
  readonly projectPath?: string
  readonly harnessVersion?: string
  readonly startedAt?: string
  readonly updatedAt?: string
  readonly metadata?: Readonly<Record<string, Session["metadata"][string]>>
  readonly relationships?: ReadonlyArray<SessionRelationship>
}

export type Emission =
  | { readonly _tag: "Event"; readonly event: IdentifiedDraft }
  | { readonly _tag: "Warning"; readonly warning: ImportWarning }
  | { readonly _tag: "Metadata"; readonly patch: MetadataPatch }

export const Emission = {
  event: (event: IdentifiedDraft): Emission => ({ _tag: "Event", event }),
  warning: (warning: ImportWarning): Emission => ({ _tag: "Warning", warning }),
  metadata: (patch: MetadataPatch): Emission => ({ _tag: "Metadata", patch })
}

// ---------------------------------------------------------------------------
// Record scope: deterministic IDs for events derived from one native record
// ---------------------------------------------------------------------------

export interface RecordScopeOptions {
  readonly harness: string
  readonly sessionId: SessionId
  readonly format: string
  readonly path: string
  readonly recordIndex: number
  readonly nativeEventId?: string | undefined
  readonly timestamp?: string | undefined
  readonly version?: string | undefined
}

/**
 * Builds events for one native record. IDs follow spec §33: the native event ID
 * when the source has one, otherwise the record index; the derivation index
 * counts events of the same type produced by this record.
 */
export class RecordScope {
  readonly source: SourceReference
  private readonly counters = new Map<string, number>()
  private readonly emitted: Array<Emission> = []
  readonly options: RecordScopeOptions

  constructor(options: RecordScopeOptions) {
    this.options = options
    this.source = {
      provider: options.harness,
      format: options.format,
      path: options.path,
      recordIndex: options.recordIndex,
      ...(options.nativeEventId !== undefined ? { nativeEventId: options.nativeEventId } : {}),
      ...(options.version !== undefined ? { version: options.version } : {})
    }
  }

  /** Reserve the ID the next event of `type` will get, so parents can be referenced before emission. */
  nextId(type: SessionEvent["type"]): EventId {
    const derivationIndex = this.counters.get(type) ?? 0
    return this.idFor(type, derivationIndex)
  }

  private idFor(type: string, derivationIndex: number): EventId {
    const { harness, nativeEventId, recordIndex, sessionId } = this.options
    const id = nativeEventId !== undefined
      ? stableEventId({ harness, sessionId, canonicalType: type, derivationIndex, nativeEventId })
      : stableEventId({ harness, sessionId, canonicalType: type, derivationIndex, recordIndex })
    return id as EventId
  }

  /** Emit an event. `source` and `timestamp` default to this record's. Returns its ID. */
  event<D extends DistributiveOptional<EventDraft, "source">>(draft: D): EventId {
    const derivationIndex = this.counters.get(draft.type) ?? 0
    this.counters.set(draft.type, derivationIndex + 1)
    const id = this.idFor(draft.type, derivationIndex)
    const { timestamp: own, ...rest } = draft as { timestamp?: string }
    const timestamp = normalizeTimestamp(own ?? this.options.timestamp)
    const event = {
      source: this.source,
      ...rest,
      ...(timestamp !== undefined ? { timestamp } : {}),
      id
    } as IdentifiedDraft
    this.emitted.push(Emission.event(event))
    return id
  }

  warning(code: string, message: string): void {
    this.emitted.push(Emission.warning({ code, message, source: this.source }))
  }

  metadata(patch: MetadataPatch): void {
    this.emitted.push(Emission.metadata(patch))
  }

  get emissions(): ReadonlyArray<Emission> {
    return this.emitted
  }
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Keep valid RFC 3339 timestamps as written; convert other parseable dates to UTC; drop the rest. */
export const normalizeTimestamp = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (RFC3339.test(value)) return isTimestamp(value) ? value : undefined
  const millis = Date.parse(value)
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString()
}

type DistributiveOptional<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K & keyof T> & Partial<Pick<T, K & keyof T>>
  : never

// ---------------------------------------------------------------------------
// Core pipeline stages shared by every adapter
// ---------------------------------------------------------------------------

/** Assign `sessionId` and monotonic `sequence` in emission order (spec §32). */
export const sequenceEvents = (sessionId: SessionId) =>
<E, R>(emissions: Stream.Stream<Emission, E, R>): Stream.Stream<SessionEvent, E, R> =>
  emissions.pipe(
    Stream.mapAccum(
      () => 0,
      (sequence, emission) =>
        emission._tag === "Event"
          ? [sequence + 1, [{ ...emission.event, sessionId, sequence } as SessionEvent]] as const
          : [sequence, []] as const
    )
  )

/**
 * Collapse repeated warnings into one entry per code + message with a count, so a
 * file with 10 000 malformed lines yields one warning rather than 10 000.
 */
export const summarizeWarnings = (warnings: ReadonlyArray<ImportWarning>): ReadonlyArray<ImportWarning> => {
  const grouped = new Map<string, ImportWarning & { count: number }>()
  for (const warning of warnings) addWarning(grouped, warning)
  return [...grouped.values()]
}

const addWarning = (grouped: Map<string, ImportWarning & { count: number }>, warning: ImportWarning) => {
  const key = JSON.stringify([warning.code, warning.message])
  const existing = grouped.get(key)
  if (existing) existing.count += warning.count ?? 1
  else grouped.set(key, { ...warning, count: warning.count ?? 1 })
}

export interface LoadedSession {
  readonly session: Session
  readonly warnings: ReadonlyArray<ImportWarning>
  readonly eventCount: number
}

export interface SessionBase {
  readonly harness: HarnessIdentity
  readonly capabilities: SessionCapabilities
}

/** Fold emissions into a loaded session: metadata, warnings and counts in one pass. */
export const loadSession = <E, R>(
  descriptor: SessionDescriptor,
  base: SessionBase,
  emissions: Stream.Stream<Emission, E, R>
): Effect.Effect<LoadedSession, E, R> =>
  emissions.pipe(
    Stream.runFold(
      () => ({
        eventCount: 0,
        warnings: new Map<string, ImportWarning & { count: number }>(),
        title: undefined as { value: string; priority: number } | undefined,
        patch: {} as Omit<MetadataPatch, "title">,
        metadata: {} as Record<string, Session["metadata"][string]>,
        relationships: [] as Array<SessionRelationship>,
        firstTimestamp: undefined as string | undefined,
        lastTimestamp: undefined as string | undefined
      }),
      (acc, emission) => {
        switch (emission._tag) {
          case "Event": {
            acc.eventCount++
            const timestamp = emission.event.timestamp
            if (timestamp !== undefined) {
              acc.firstTimestamp ??= timestamp
              acc.lastTimestamp = timestamp
            }
            break
          }
          case "Warning":
            addWarning(acc.warnings, emission.warning)
            break
          case "Metadata": {
            const { metadata, relationships, title, ...rest } = emission.patch
            if (relationships) acc.relationships.push(...relationships)
            if (title && (acc.title === undefined || title.priority >= acc.title.priority)) acc.title = title
            if (metadata) Object.assign(acc.metadata, metadata)
            acc.patch = { ...acc.patch, ...rest }
            break
          }
        }
        return acc
      }
    ),
    Effect.map((acc): LoadedSession => {
      const projectPath = acc.patch.projectPath ?? descriptor.projectPath
      const startedAt = normalizeTimestamp(acc.patch.startedAt) ?? normalizeTimestamp(descriptor.startedAt) ?? acc.firstTimestamp
      const updatedAt = normalizeTimestamp(acc.patch.updatedAt) ?? acc.lastTimestamp ?? normalizeTimestamp(descriptor.updatedAt)
      const version = acc.patch.harnessVersion ?? base.harness.version
      const session: Session = {
        id: descriptor.id,
        harness: { ...base.harness, ...(version !== undefined ? { version } : {}) },
        // History never records an explicit end; see docs/protocol.md#session-status.
        status: "unknown",
        ...(acc.title !== undefined ? { title: acc.title.value } : {}),
        ...(projectPath !== undefined ? { projectPath } : {}),
        ...(descriptor.parentSessionId !== undefined ? { parentSessionId: descriptor.parentSessionId } : {}),
        ...(descriptor.agentLabel !== undefined ? { agentLabel: descriptor.agentLabel } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(acc.relationships.length > 0 ? { relationships: acc.relationships } : {}),
        capabilities: base.capabilities,
        metadata: acc.metadata
      }
      return { session, warnings: [...acc.warnings.values()], eventCount: acc.eventCount }
    })
  )
