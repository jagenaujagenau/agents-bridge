import type { ValidationKind } from "../story/commands.ts"
import type { TurnClaims } from "./claims.ts"
import type { CommandId, EventId, ImportWarning, Session, SessionEvent, ToolCallId } from "@agentbridge/schema"

/**
 * Replay's presentation model (GOAL §17). Derived from canonical Bridge data, never
 * written back to it: chapters, scenes and activity are Replay's reading of the
 * evidence, not Bridge truth.
 */

export type ChapterId = string & { readonly ChapterId: unique symbol }
export type SceneId = string & { readonly SceneId: unique symbol }

export const chapterId = (index: number) => `ch${index + 1}` as ChapterId
export const sceneId = (index: number) => `sc${index + 1}` as SceneId
/** Position of a scene or chapter in its array. */
export const indexOfId = (id: SceneId | ChapterId): number => Number(id.slice(2)) - 1

/** What a scene's actions were mostly doing. */
export type SceneKind = "read" | "change" | "validate" | "command" | "conversation"

export type ChapterKind = "exploration" | "implementation" | "validation" | "debugging" | "other"

/** How a validation command ended, as far as the evidence says. */
export type ValidationOutcome = "passed" | "failed" | "unknown"

export interface ReplayScene {
  readonly id: SceneId
  readonly chapterId: ChapterId
  readonly index: number
  readonly kind: SceneKind
  readonly title: string
  readonly description?: string | undefined
  readonly eventIds: ReadonlyArray<EventId>
  readonly filePaths: ReadonlyArray<string>
  readonly commandIds: ReadonlyArray<CommandId>
  readonly toolCallIds: ReadonlyArray<ToolCallId>
  readonly startSequence: number
  readonly endSequence: number
  /** Set on validation scenes. */
  readonly outcome?: ValidationOutcome | undefined
  /** The check a validation scene ran, e.g. `pnpm test auth`. */
  readonly check?: {
    readonly kind: ValidationKind
    readonly command: string
    readonly commandId: CommandId
    readonly inferred?: InferredOutcome | undefined
  } | undefined
}

export interface ReplayChapter {
  readonly id: ChapterId
  readonly index: number
  readonly title: string
  readonly summary?: string | undefined
  /** The prompt that opened this chapter, when one did. */
  readonly promptEventId?: EventId | undefined
  readonly sceneIds: ReadonlyArray<SceneId>
  readonly eventIds: ReadonlyArray<EventId>
  readonly filePaths: ReadonlyArray<string>
  readonly startSequence: number
  readonly endSequence: number
  readonly kind: ChapterKind
  readonly derivation: "deterministic" | "ai" | "user"
}

export interface ReplayFile {
  /** Relative to the session's project when inside it, otherwise as observed. */
  readonly path: string
  readonly region: string
  readonly language?: string | undefined
  /** How much the session touched the file (GOAL §10). Not importance. */
  readonly activity: number
  readonly readCount: number
  readonly changeCount: number
  readonly created: boolean
  readonly deleted: boolean
  readonly sceneIds: ReadonlyArray<SceneId>
  readonly eventIds: ReadonlyArray<EventId>
  readonly additions?: number | undefined
  readonly deletions?: number | undefined
}

export interface MapPosition {
  readonly x: number
  readonly y: number
  readonly radius: number
}

export interface MapRegion extends MapPosition {
  readonly id: string
  readonly files: ReadonlyArray<string>
}

/** Geography computed once per session; immutable while the session is open (GOAL §8). */
export interface ReplayMap {
  readonly size: number
  readonly regions: ReadonlyArray<MapRegion>
  readonly nodes: ReadonlyMap<string, MapPosition>
}

export interface TimelineEntry {
  readonly eventId: EventId
  readonly sequence: number
  readonly sceneId: SceneId
  readonly chapterId: ChapterId
  readonly timestamp?: string | undefined
  /** Presentation time at 1x, in milliseconds (GOAL §14). */
  readonly dwellMs: number
}

/** The events playback steps through, in order. Bookkeeping events are left out. */
export interface ReplayTimeline {
  readonly entries: ReadonlyArray<TimelineEntry>
  readonly indexByEvent: ReadonlyMap<EventId, number>
  readonly firstIndexByScene: ReadonlyMap<SceneId, number>
  readonly firstIndexByChapter: ReadonlyMap<ChapterId, number>
}

export interface ReplayEventIndex {
  readonly eventById: ReadonlyMap<EventId, SessionEvent>
  readonly sceneByEvent: ReadonlyMap<EventId, SceneId>
  readonly scenesByFile: ReadonlyMap<string, ReadonlyArray<SceneId>>
  readonly eventsByFile: ReadonlyMap<string, ReadonlyArray<EventId>>
  /** Normalized file path of a file event. */
  readonly fileByEvent: ReadonlyMap<EventId, string>
}

/**
 * A System One judgment of a check's result, made from its recorded output when the
 * shell's exit status could not say (GOAL §21: AI decorates, never replaces evidence).
 */
export interface CheckJudgment {
  readonly outcome: "passed" | "failed" | "unclear"
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
  /** The versioned model that answered, e.g. `jev-1.13.0`. */
  readonly model: string
}

/** Probabilities that the agent's closing reply to a request says each thing. */
export interface ReplyJudgment {
  readonly done: number
  readonly testsPass: number
  readonly checksPass: number
  readonly openProblem: number
  readonly model: string
}

/** Whether a command the rules did not recognise is a check, judged from its text and output. */
export interface CommandKindJudgment {
  readonly kind: ValidationKind | "not_a_check"
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
  readonly model: string
}

/** Where a check's reported outcome came from. */
export interface InferredOutcome {
  readonly model: string
  readonly confidence: number
}

export interface CheckResult {
  readonly kind: ValidationKind
  readonly command: string
  /** Outcome of the last run of this check. */
  readonly outcome: ValidationOutcome
  /** Set when that outcome was inferred from output rather than recorded. */
  readonly inferred?: InferredOutcome | undefined
  readonly runs: number
  /** The scene of the last run, for linking a summary line to its evidence. */
  readonly lastSceneId: SceneId
}

export interface ReplayStats {
  readonly prompts: number
  readonly filesRead: number
  readonly filesChanged: number
  /** Commands that did work. Read-only inspection (`ls`, `cat`, `git diff`) is counted separately. */
  readonly commands: number
  readonly failedCommands: number
  readonly inspections: number
  readonly failedInspections: number
  readonly validations: number
  /** Final state of each distinct check, in order of first run. */
  readonly checks: ReadonlyArray<CheckResult>
  readonly durationMs?: number | undefined
}

export interface ReplaySession {
  readonly session: Session
  readonly warnings: ReadonlyArray<ImportWarning>
  readonly title: string
  readonly summary: string
  readonly stats: ReplayStats
  readonly events: ReadonlyArray<SessionEvent>
  readonly chapters: ReadonlyArray<ReplayChapter>
  readonly scenes: ReadonlyArray<ReplayScene>
  readonly files: ReadonlyMap<string, ReplayFile>
  readonly map: ReplayMap
  readonly timeline: ReplayTimeline
  readonly eventIndex: ReplayEventIndex
  /**
   * Checks whose result is unknown only because the shell hid it, and that recorded
   * output a judgment could read. Empty once judgments are applied or unavailable.
   */
  readonly checksToJudge: ReadonlyArray<CommandId>
  /** What the agent's closing reply to each request claims, once judged. */
  readonly turns: ReadonlyArray<TurnClaims>
  /** Closing replies not judged yet. */
  readonly repliesToJudge: ReadonlyArray<EventId>
  /** Commands the rules do not recognise that might be checks, not judged yet. */
  readonly commandsToClassify: ReadonlyArray<CommandId>
}
