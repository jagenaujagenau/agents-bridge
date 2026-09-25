import type { EventId, ImportWarning, Session, SessionEvent } from "@agentbridge/schema"
import { Effect, Schema, Stream } from "effect"
import { layoutMap } from "../map/layout.ts"
import { assessTurns } from "./claims.ts"
import { classifyCommand, shortCommand, validationLabel } from "../story/commands.ts"
import { type CommandKinds, deriveStory, type Judgments, promptText } from "../story/deterministic.ts"
import { diffStat, languageOf, normalizePath, regionOf } from "./files.ts"
import type {
  ChapterId,
  CheckResult,
  ReplayChapter,
  ReplayEventIndex,
  ReplayFile,
  ReplayScene,
  ReplaySession,
  ReplayStats,
  ReplayTimeline,
  ReplyJudgment,
  SceneId,
  TimelineEntry,
  ValidationOutcome
} from "./model.ts"

export class ReplayDerivationError extends Schema.TaggedError<ReplayDerivationError>()("ReplayDerivationError", {
  message: Schema.String
}) {}

/** Activity weights (GOAL §10). */
const READ_WEIGHT = 1
const CHANGE_WEIGHT = 4

const fileEventPath = (e: SessionEvent): string | undefined =>
  e.type === "file.read" || e.type === "file.created" || e.type === "file.changed" || e.type === "file.deleted"
    ? e.path
    : undefined

interface MutableFile {
  path: string
  language?: string | undefined
  readCount: number
  changeCount: number
  created: boolean
  deleted: boolean
  sceneIds: Set<SceneId>
  eventIds: Array<EventId>
  additions?: number
  deletions?: number
}

const deriveFiles = (
  events: ReadonlyArray<SessionEvent>,
  norm: (p: string) => string,
  sceneByEvent: ReadonlyMap<EventId, SceneId>
): { files: Map<string, ReplayFile>; fileByEvent: Map<EventId, string> } => {
  const files = new Map<string, MutableFile>()
  const fileByEvent = new Map<EventId, string>()
  for (const e of events) {
    const raw = fileEventPath(e)
    if (raw === undefined) continue
    const path = norm(raw)
    fileByEvent.set(e.id, path)
    const file = files.get(path) ??
      { path, readCount: 0, changeCount: 0, created: false, deleted: false, sceneIds: new Set(), eventIds: [] }
    files.set(path, file)
    file.eventIds.push(e.id)
    const scene = sceneByEvent.get(e.id)
    if (scene !== undefined) file.sceneIds.add(scene)
    if (e.type === "file.read") file.readCount++
    else file.changeCount++
    if (e.type === "file.created") file.created = true
    if (e.type === "file.deleted") file.deleted = true
    if ((e.type === "file.created" || e.type === "file.changed") && e.diff !== undefined) {
      const stat = diffStat(e.diff)
      file.additions = (file.additions ?? 0) + stat.additions
      file.deletions = (file.deletions ?? 0) + stat.deletions
    }
    if ((e.type === "file.created" || e.type === "file.changed") && e.language !== undefined) file.language = e.language
  }
  const out = new Map<string, ReplayFile>()
  for (const f of files.values()) {
    out.set(f.path, {
      path: f.path,
      region: regionOf(f.path),
      language: f.language ?? languageOf(f.path),
      activity: f.readCount * READ_WEIGHT + f.changeCount * CHANGE_WEIGHT,
      readCount: f.readCount,
      changeCount: f.changeCount,
      created: f.created,
      deleted: f.deleted,
      sceneIds: [...f.sceneIds],
      eventIds: f.eventIds,
      additions: f.additions,
      deletions: f.deletions
    })
  }
  return { files: out, fileByEvent }
}

/** Presentation time per event type at 1x (GOAL §14). Types absent here are not stepped through. */
const dwell: Partial<Record<SessionEvent["type"], number>> = {
  "user.message": 2600,
  "agent.message": 2000,
  "agent.reasoning": 1200,
  "harness.notice": 900,
  "context.compacted": 900,
  "plan.updated": 1200,
  "tool.started": 600,
  "tool.failed": 1000,
  "command.started": 900,
  "command.completed": 1400,
  "file.read": 700,
  "file.created": 1600,
  "file.changed": 1600,
  "file.deleted": 1200,
  "git.commit": 1600,
  "session.failed": 1200
}

const buildTimeline = (
  events: ReadonlyArray<SessionEvent>,
  scenes: ReadonlyArray<ReplayScene>,
  sceneByEvent: ReadonlyMap<EventId, SceneId>
): ReplayTimeline => {
  // A tool call whose effect Bridge already expressed as file or command events is shown through those.
  const parents = new Set(events.flatMap((e) => (e.parentEventId !== undefined ? [e.parentEventId] : [])))
  const chapterOf = new Map(scenes.map((s) => [s.id, s.chapterId]))
  const playable = (e: SessionEvent) =>
    dwell[e.type] !== undefined && !(e.type === "tool.started" && parents.has(e.id)) &&
    !(e.type === "harness.notice" && e.kind !== "error" && e.kind !== "interruption")
  const selected = events.filter(playable)
  const entries: Array<TimelineEntry> = (selected.length > 0 ? selected : events).flatMap((e) => {
    const sceneId = sceneByEvent.get(e.id)
    if (sceneId === undefined) return []
    return [{
      eventId: e.id,
      sequence: e.sequence,
      sceneId,
      chapterId: chapterOf.get(sceneId)!,
      timestamp: e.timestamp,
      dwellMs: dwell[e.type] ?? 600
    }]
  })
  const indexByEvent = new Map<EventId, number>()
  const firstIndexByScene = new Map<SceneId, number>()
  const firstIndexByChapter = new Map<ChapterId, number>()
  entries.forEach((entry, i) => {
    indexByEvent.set(entry.eventId, i)
    if (!firstIndexByScene.has(entry.sceneId)) firstIndexByScene.set(entry.sceneId, i)
    if (!firstIndexByChapter.has(entry.chapterId)) firstIndexByChapter.set(entry.chapterId, i)
  })
  return { entries, indexByEvent, firstIndexByScene, firstIndexByChapter }
}

const buildStats = (
  session: Session,
  events: ReadonlyArray<SessionEvent>,
  files: ReadonlyMap<string, ReplayFile>,
  scenes: ReadonlyArray<ReplayScene>
): ReplayStats => {
  const stamps = events.flatMap((e) => (e.timestamp !== undefined ? [Date.parse(e.timestamp)] : []))
  const start = session.startedAt !== undefined ? Date.parse(session.startedAt) : stamps[0]
  const end = session.endedAt !== undefined ? Date.parse(session.endedAt) : stamps.at(-1)
  const validations = scenes.filter((s) => s.check !== undefined)
  const checks = new Map<string, CheckResult>()
  for (const scene of validations) {
    const { kind, command } = scene.check!
    checks.set(command, {
      kind,
      command,
      outcome: scene.outcome ?? "unknown",
      inferred: scene.check!.inferred,
      runs: (checks.get(command)?.runs ?? 0) + 1,
      lastSceneId: scene.id
    })
  }
  // Commands and their failures are counted over the same population.
  const inspection = new Map<string, boolean>()
  for (const e of events) if (e.type === "command.started") inspection.set(e.commandId, classifyCommand(e.command).type === "read")
  const failed = events.flatMap((e) => (e.type === "command.completed" && e.outcome === "failed" ? [e.commandId] : []))
  const fileList = [...files.values()]
  return {
    prompts: events.filter((e) => e.type === "user.message").length,
    filesRead: fileList.filter((f) => f.readCount > 0).length,
    filesChanged: fileList.filter((f) => f.changeCount > 0).length,
    commands: [...inspection.values()].filter((read) => !read).length,
    failedCommands: failed.filter((id) => inspection.get(id) !== true).length,
    inspections: [...inspection.values()].filter((read) => read).length,
    failedInspections: failed.filter((id) => inspection.get(id) === true).length,
    validations: validations.length,
    checks: [...checks.values()],
    durationMs: start !== undefined && end !== undefined && end >= start ? end - start : undefined
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const joinList = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/** A factual one-paragraph overview. Never claims intent. */
const buildSummary = (
  stats: ReplayStats,
  events: ReadonlyArray<SessionEvent>,
  files: ReadonlyMap<string, ReplayFile>,
  chapters: ReadonlyArray<ReplayChapter>
) => {
  const regions = new Set([...files.values()].filter((f) => f.changeCount > 0).map((f) => f.region))
  const parts = [`${plural(stats.prompts, "prompt")}, ${plural(chapters.length, "chapter")}.`]
  const work: Array<string> = []
  if (stats.filesRead > 0) work.push(`read ${plural(stats.filesRead, "file")}`)
  if (stats.filesChanged > 0) {
    work.push(`changed ${plural(stats.filesChanged, "file")}${regions.size > 1 ? ` across ${regions.size} directories` : ""}`)
  }
  if (stats.commands > 0) {
    work.push(`ran ${plural(stats.commands, "command")}${stats.failedCommands > 0 ? ` (${stats.failedCommands} failed)` : ""}`)
  }
  if (stats.failedInspections > 0) work.push(`had ${plural(stats.failedInspections, "inspection command")} fail`)
  if (work.length > 0) parts.push(`The agent ${work.join(", ")}.`)
  else if (stats.inspections > 0) parts.push("The agent only inspected the project.")
  else if (!events.some((e) => e.type === "command.started" || fileEventPath(e) !== undefined)) {
    parts.push("No files or commands were recorded.")
  }
  if (stats.checks.length > 0) {
    // Two different checks can share a label ("the typecheck"); then the command tells them apart.
    const labelCount = new Map<string, number>()
    for (const c of stats.checks) labelCount.set(c.kind, (labelCount.get(c.kind) ?? 0) + 1)
    const name = (c: CheckResult) =>
      `${validationLabel[c.kind]}${labelCount.get(c.kind)! > 1 ? ` (${shortCommand(c.command, 40)})` : ""}` +
      (c.inferred !== undefined ? " (inferred)" : "")
    const byOutcome = (o: ValidationOutcome) => stats.checks.filter((c) => c.outcome === o).map(name)
    const [failing, passing, unclear] = [byOutcome("failed"), byOutcome("passed"), byOutcome("unknown")]
    if (failing.length > 0) parts.push(`Still failing at its last run: ${joinList(unique(failing))}.`)
    if (passing.length > 0) parts.push(`Passed at its last run: ${joinList(unique(passing))}.`)
    if (unclear.length > 0) parts.push(`Result not recorded or masked by the shell: ${joinList(unique(unclear))}.`)
  }
  return parts.join(" ")
}

const unique = <A>(items: ReadonlyArray<A>): Array<A> => [...new Set(items)]

/** A session's display title: its own, else the first line of its first prompt. */
export const sessionTitle = (session: Session, events: Iterable<SessionEvent>): string => {
  // Titles often come from a prompt, and a prompt that opens with a markdown heading
  // ("# Objective") is titled by its text.
  const clean = (title: string) => title.replace(/^#+\s+/, "")
  if (session.title !== undefined) return clean(session.title)
  for (const e of events) {
    if (e.type === "user.message") {
      const prompt = promptText(e)
      if (prompt !== undefined) return clean(firstLine(prompt))
    }
  }
  return "Untitled session"
}

const firstLine = (text: string, max = 90) => {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export interface DeriveOptions {
  /**
   * Optional judgments of check results the shell hid, keyed by command ID. Without
   * them the derivation is fully deterministic and offline.
   */
  readonly judgments?: Judgments | undefined
  /** Optional judgments of whether unrecognised commands are checks, keyed by command ID. */
  readonly commandKinds?: CommandKinds | undefined
  /** Optional judgments of the agent's closing replies, keyed by reply event ID. */
  readonly replies?: ReadonlyMap<string, ReplyJudgment> | undefined
}

/** Pure derivation over a complete, sequence-ordered event list. */
export const deriveReplay = (
  session: Session,
  events: ReadonlyArray<SessionEvent>,
  warnings: ReadonlyArray<ImportWarning> = [],
  options: DeriveOptions = {}
): ReplaySession => {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  const norm = normalizePath(session.projectPath ?? session.workspacePath)
  const story = deriveStory(ordered, norm, options.judgments, options.commandKinds)
  const { files, fileByEvent } = deriveFiles(ordered, norm, story.sceneByEvent)

  const scenesByFile = new Map<string, ReadonlyArray<SceneId>>()
  const eventsByFile = new Map<string, ReadonlyArray<EventId>>()
  for (const file of files.values()) {
    scenesByFile.set(file.path, file.sceneIds)
    eventsByFile.set(file.path, file.eventIds)
  }
  const eventIndex: ReplayEventIndex = {
    eventById: new Map(ordered.map((e) => [e.id, e])),
    sceneByEvent: story.sceneByEvent,
    scenesByFile,
    eventsByFile,
    fileByEvent
  }
  const stats = buildStats(session, ordered, files, story.scenes)
  const claims = assessTurns(ordered, story.scenes, options.replies ?? new Map())
  const firstPrompt = promptText(ordered.find((e) => e.type === "user.message"))
  return {
    session,
    warnings,
    title: session.title ?? (firstPrompt !== undefined ? firstLine(firstPrompt) : "Untitled session"),
    summary: buildSummary(stats, ordered, files, story.chapters),
    stats,
    events: ordered,
    chapters: story.chapters,
    scenes: story.scenes,
    files,
    map: layoutMap(files.values()),
    timeline: buildTimeline(ordered, story.scenes, story.sceneByEvent),
    eventIndex,
    checksToJudge: story.checksToJudge,
    turns: claims.turns,
    repliesToJudge: claims.toJudge,
    commandsToClassify: story.commandsToClassify
  }
}

/** GOAL §32: collect a Bridge event stream and derive the Replay model. */
export const buildReplaySession = <E, R>(
  session: Session,
  events: Stream.Stream<SessionEvent, E, R>,
  warnings: ReadonlyArray<ImportWarning> = []
): Effect.Effect<ReplaySession, E | ReplayDerivationError, R> =>
  Stream.runCollect(events).pipe(
    Effect.flatMap((collected) =>
      Effect.try({
        try: () => deriveReplay(session, [...collected], warnings),
        catch: (cause) => new ReplayDerivationError({ message: cause instanceof Error ? cause.message : String(cause) })
      })
    )
  )
