import {
  type CommandCompleted,
  type CommandId,
  type CommandStarted,
  type EventId,
  plainText,
  type SessionEvent,
  type ToolCallId
} from "@agentbridge/schema"
import {
  chapterId,
  type ChapterKind,
  type ReplayChapter,
  type ReplayScene,
  type SceneId,
  sceneId,
  type SceneKind,
  type CheckJudgment,
  type CommandKindJudgment,
  type InferredOutcome,
  type ValidationOutcome
} from "../replay/model.ts"
import { basename, regionOf } from "../replay/files.ts"
import { projectTool } from "../replay/tools.ts"
import {
  checkCandidate,
  classifyAs,
  classifyCommand,
  inspectionLabel,
  shortCommand,
  validationLabel,
  type ValidationKind
} from "./commands.ts"

/**
 * Deterministic story derivation (GOAL §19): events → steps → scenes → chapters.
 * Uses only canonical event types, tool kinds and command text. Labels describe
 * activity, never intent.
 */

export interface ReplayStory {
  readonly scenes: ReadonlyArray<ReplayScene>
  readonly chapters: ReadonlyArray<ReplayChapter>
  readonly sceneByEvent: ReadonlyMap<EventId, SceneId>
  /** Checks whose unknown result a judgment of their output could settle. */
  readonly checksToJudge: ReadonlyArray<CommandId>
  /** Unrecognised commands that might be checks, not yet judged. */
  readonly commandsToClassify: ReadonlyArray<CommandId>
}

/** A gap this long between actions starts a new scene and chapter. */
const GAP_MS = 15 * 60_000
/** Scenes are split once they hold this many actions. */
const MAX_SCENE_ACTIONS = 12

type ActionKind = "read" | "change" | "validate" | "command"
type StepKind = ActionKind | "prompt" | "tool" | "lead" | "trail"

/** A validation run: which check, and what its own command recorded. */
export interface ValidationRun {
  readonly kind: ValidationKind
  /** Command text of the check; reruns of the same check share it. */
  readonly check: string
  readonly commandId: CommandId
  readonly outcome: ValidationOutcome
  /** Set when `outcome` was inferred from the check's output instead of recorded. */
  readonly inferred?: InferredOutcome | undefined
  /** Set when the command was only identified as a check by a judgment. */
  readonly kindInferred?: InferredOutcome | undefined
  /** The recorded outcome is unknown, but there is output a judgment could read. */
  readonly judgeable: boolean
}

export type Judgments = ReadonlyMap<string, CheckJudgment>
export type CommandKinds = ReadonlyMap<string, CommandKindJudgment>

/** Commands the rules do not know count as checks only above this confidence (README). */
export const MIN_COMMAND_KIND_CONFIDENCE = 0.6

/** Judgments below this confidence leave a check's result unknown. */
// ponytail: one fixed threshold; tune per model version against a labeled set (scripts/eval-jev.ts).
export const MIN_JUDGMENT_CONFIDENCE = 0.6

/** A root event plus everything structurally attached to it (tool results, derived file and command events). */
interface Step {
  readonly root: SessionEvent
  readonly events: Array<SessionEvent>
  kind: StepKind
  validation?: ValidationRun
  gapBefore: boolean
}

/** Events that introduce what follows, so they travel with the next action. */
const leading = new Set<string>(["agent.reasoning", "agent.message", "turn.started", "session.started", "harness.notice"])

const isChange = (e: SessionEvent) => e.type === "file.created" || e.type === "file.changed" || e.type === "file.deleted"

const buildSteps = (events: ReadonlyArray<SessionEvent>, judgments: Judgments, kinds: CommandKinds): Array<Step> => {
  const byId = new Map(events.map((e) => [e.id, e]))
  const toolStart = new Map<string, EventId>()
  const commandStart = new Map<string, EventId>()
  const rootOf = new Map<EventId, EventId>()
  const steps = new Map<EventId, Step>()

  // Canonical links: structural parents, then tool results by call ID and command results by command ID.
  const parentOf = (e: SessionEvent): EventId | undefined => {
    if (e.parentEventId !== undefined && byId.has(e.parentEventId)) return e.parentEventId
    if (e.type === "tool.completed" || e.type === "tool.failed" || e.type === "tool.updated") return toolStart.get(e.toolCallId)
    if (e.type === "command.completed") return commandStart.get(e.commandId)
    if (e.type === "git.commit") return e.derivedFrom?.find((id) => byId.has(id))
    return undefined
  }

  for (const e of events) {
    if (e.type === "tool.started") toolStart.set(e.toolCallId, e.id)
    if (e.type === "command.started") commandStart.set(e.commandId, e.id)
    const parent = parentOf(e)
    const root = parent !== undefined ? rootOf.get(parent) ?? parent : e.id
    rootOf.set(e.id, root)
    const step = steps.get(root)
    if (step !== undefined) step.events.push(e)
    else steps.set(root, { root: byId.get(root) ?? e, events: [e], kind: "trail", gapBefore: false })
  }

  const ordered = [...steps.values()]
  for (const step of ordered) classify(step, judgments, kinds)
  return ordered
}

/** The outcome of one command's check, from that command's own completion. */
/** A command's class, using a confident judgment for commands the rules do not recognise. */
const commandClass = (started: CommandStarted, kinds: CommandKinds) => {
  const cls = classifyCommand(started.command)
  if (cls.type !== "other") return { cls, kindInferred: undefined }
  const judged = kinds.get(started.commandId)
  if (judged === undefined || judged.kind === "not_a_check" || judged.confidence < MIN_COMMAND_KIND_CONFIDENCE) {
    return { cls, kindInferred: undefined }
  }
  return { cls: classifyAs(started.command, judged.kind), kindInferred: { model: judged.model, confidence: judged.confidence } }
}

export const validationRun = (
  started: CommandStarted,
  events: ReadonlyArray<SessionEvent>,
  judgments: Judgments = new Map(),
  kinds: CommandKinds = new Map()
): ValidationRun | undefined => {
  const { cls, kindInferred } = commandClass(started, kinds)
  if (cls.type !== "validation") return undefined
  const done = events.find((e): e is CommandCompleted => e.type === "command.completed" && e.commandId === started.commandId)
  const shell = done !== undefined
    ? done.outcome
    : events.some((e) => e.type === "tool.failed")
    ? "failed"
    : "unknown"
  // A pipe or `||` after the check means the shell's status is not the check's.
  const outcome: ValidationOutcome = !cls.exitReflectsCheck
    ? "unknown"
    : shell === "succeeded"
    ? "passed"
    : shell === "failed"
    ? "failed"
    : "unknown"
  const base = { kind: cls.kind, check: cls.check, commandId: started.commandId as CommandId, kindInferred }
  if (outcome !== "unknown") return { ...base, outcome, judgeable: false }
  // Only an unknown result is ever filled in, and only by a confident judgment of its own output.
  const judgment = judgments.get(started.commandId)
  if (judgment !== undefined && judgment.outcome !== "unclear" && judgment.confidence >= MIN_JUDGMENT_CONFIDENCE) {
    return {
      ...base,
      outcome: judgment.outcome,
      inferred: { model: judgment.model, confidence: judgment.confidence },
      judgeable: false
    }
  }
  const output = `${done?.stdout ?? ""}${done?.stderr ?? ""}`.trim()
  // Output mixed with later commands' output cannot speak for the check, so it is not judged.
  return { ...base, outcome, judgeable: judgment === undefined && output !== "" && cls.outputIsCheck }
}

const classify = (step: Step, judgments: Judgments, kinds: CommandKinds): void => {
  const { root, events } = step
  if (root.type === "user.message") {
    step.kind = "prompt"
    return
  }
  const commands = events.filter((e): e is CommandStarted => e.type === "command.started")
  if (commands.length > 0) {
    const run = commands.map((c) => validationRun(c, events, judgments, kinds)).find((r) => r !== undefined)
    if (run !== undefined) {
      step.kind = "validate"
      step.validation = run
    } else step.kind = commands.every((c) => classifyCommand(c.command).type === "read") ? "read" : "command"
    return
  }
  if (events.some(isChange)) step.kind = "change"
  else if (events.some((e) => e.type === "file.read")) step.kind = "read"
  else if (root.type === "tool.started") {
    const kind = projectTool(root, events).kind
    step.kind = kind === "edit" || kind === "delete" || kind === "move"
      ? "change"
      : kind === "read" || kind === "search" || kind === "fetch"
      ? "read"
      : kind === "execute"
      ? "command"
      : "tool"
  } else step.kind = leading.has(root.type) ? "lead" : "trail"
}

const timeOf = (step: Step): number | undefined => {
  for (const e of step.events) if (e.timestamp !== undefined) return Date.parse(e.timestamp)
  return undefined
}

const isAction = (kind: StepKind): kind is ActionKind | "prompt" =>
  kind === "read" || kind === "change" || kind === "validate" || kind === "command" || kind === "prompt"

/** Mark time gaps, and fold short reads that lead straight into an edit into that edit. */
const refine = (steps: ReadonlyArray<Step>): void => {
  const actions = steps.filter((s) => isAction(s.kind))
  let last: number | undefined
  for (const step of actions) {
    const t = timeOf(step)
    if (t !== undefined && last !== undefined && t - last > GAP_MS) step.gapBefore = true
    if (t !== undefined) last = t
  }
  for (let i = 0; i < actions.length; i++) {
    let j = i
    while (j < actions.length && actions[j]!.kind === "read" && (j === i || !actions[j]!.gapBefore)) j++
    const next = actions[j]
    if (j > i && j - i <= 2 && next?.kind === "change" && !next.gapBefore) {
      for (let k = i; k < j; k++) actions[k]!.kind = "change"
    }
    i = Math.max(i, j - 1)
  }
}

interface SceneDraft {
  kind: SceneKind
  actions: number
  startsChapter: boolean
  steps: Array<Step>
}

const buildScenes = (steps: ReadonlyArray<Step>): Array<SceneDraft> => {
  const scenes: Array<SceneDraft> = []
  let current: SceneDraft | undefined
  let pending: Array<Step> = []
  const open = (kind: SceneKind, startsChapter: boolean): SceneDraft => {
    const scene: SceneDraft = { kind, actions: 0, startsChapter, steps: [] }
    scenes.push(scene)
    return scene
  }
  const flushInto = (scene: SceneDraft) => {
    scene.steps.push(...pending)
    pending = []
  }

  for (const step of steps) {
    switch (step.kind) {
      case "lead":
        pending.push(step)
        break
      case "trail":
      case "tool":
        if (current === undefined) pending.push(step)
        else current.steps.push(step)
        break
      case "prompt": {
        const previous: SceneDraft | undefined = current
        current = open("conversation", true)
        flushInto(previous ?? current)
        current.steps.push(step)
        break
      }
      default: {
        const kind = step.kind
        const fresh = current === undefined || step.gapBefore ||
          (current.actions > 0 && (current.kind !== kind || kind === "validate")) ||
          current.actions >= MAX_SCENE_ACTIONS
        if (fresh) current = open(kind, current === undefined || step.gapBefore)
        const scene = current!
        flushInto(scene)
        scene.kind = kind
        scene.actions++
        scene.steps.push(step)
      }
    }
  }
  if (pending.length > 0) flushInto(current ?? open("conversation", true))
  return scenes
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

type Norm = (path: string) => string

interface SceneFacts {
  readonly events: ReadonlyArray<SessionEvent>
  readonly reads: ReadonlyArray<string>
  readonly changes: ReadonlyArray<string>
  readonly created: ReadonlySet<string>
  readonly deleted: ReadonlySet<string>
  /** Every command, inspection included. */
  readonly commands: ReadonlyArray<string>
  /** Commands that did work: everything but read-only inspection (`ls`, `cat`, `git diff`). */
  readonly workCommands: number
  readonly failedWork: number
  readonly failedInspections: number
  readonly tools: ReadonlyArray<string>
  readonly commit?: string | undefined
  /** Validation runs in order. */
  readonly runs: ReadonlyArray<ValidationRun>
  /** The last validation run. */
  readonly validation?: ValidationRun | undefined
}

const unique = <A>(items: Iterable<A>): Array<A> => [...new Set(items)]

const factsOf = (steps: ReadonlyArray<Step>, norm: Norm): SceneFacts => {
  const events = steps.flatMap((s) => s.events).sort((a, b) => a.sequence - b.sequence)
  const created = new Set<string>()
  const deleted = new Set<string>()
  let commit: string | undefined
  const inspection = new Map<string, boolean>()
  for (const e of events) {
    if (e.type === "command.started") inspection.set(e.commandId, classifyCommand(e.command).type === "read")
  }
  let failedWork = 0
  let failedInspections = 0
  for (const e of events) {
    if (e.type === "file.created") created.add(norm(e.path))
    if (e.type === "file.deleted") deleted.add(norm(e.path))
    if (e.type === "git.commit") commit ??= e.message ?? "a commit"
    if (e.type === "command.completed" && e.outcome === "failed") {
      if (inspection.get(e.commandId) === true) failedInspections++
      else failedWork++
    }
  }
  const runs = steps.flatMap((s) => (s.validation !== undefined ? [s.validation] : []))
  const toolEvents = events.filter((e) => e.type === "tool.updated")
  return {
    events,
    reads: unique(events.flatMap((e) => (e.type === "file.read" ? [norm(e.path)] : []))),
    changes: unique(events.flatMap((e) => (isChange(e) ? [norm((e as { path: string }).path)] : []))),
    created,
    deleted,
    commands: events.flatMap((e) => (e.type === "command.started" ? [e.command] : [])),
    workCommands: [...inspection.values()].filter((read) => !read).length,
    failedWork,
    failedInspections,
    tools: events.flatMap((e) => (e.type === "tool.started" ? [projectTool(e, toolEvents).kind] : [])),
    commit,
    runs,
    validation: runs.at(-1)
  }
}

/** A region holding at least 60% of the paths, if there is one worth naming. */
const focus = (paths: ReadonlyArray<string>): string | undefined => {
  const counts = new Map<string, number>()
  for (const p of paths) counts.set(regionOf(p), (counts.get(regionOf(p)) ?? 0) + 1)
  const [region, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? []
  return region !== undefined && region !== "." && region !== "/" && count! / paths.length >= 0.6 ? region : undefined
}

const listFiles = (paths: ReadonlyArray<string>): string =>
  paths.length === 1 ? basename(paths[0]!) : `${basename(paths[0]!)} and ${basename(paths[1]!)}`

const describeReads = (f: SceneFacts): string => {
  if (f.reads.length === 0) {
    if (f.tools.includes("fetch")) return "Fetched from the web"
    if (f.tools.includes("search")) return "Searched the codebase"
    return f.commands.length > 0 ? inspectionLabel(f.commands) : "Looked around"
  }
  if (f.reads.length <= 2) return `Read ${listFiles(f.reads)}`
  const region = focus(f.reads)
  return region !== undefined ? `Explored ${region}` : `Read ${f.reads.length} files`
}

const describeChanges = (f: SceneFacts): string => {
  const paths = f.changes
  if (paths.length === 0) return f.events.some((e) => e.type === "tool.failed") ? "Tried to edit files (failed)" : "Edited files"
  const verb = (p: string) => (f.created.has(p) ? "Created" : f.deleted.has(p) ? "Deleted" : "Changed")
  if (paths.length === 1) return `${verb(paths[0]!)} ${basename(paths[0]!)}`
  if (paths.length === 2) {
    const same = verb(paths[0]!) === verb(paths[1]!)
    return same ? `${verb(paths[0]!)} ${listFiles(paths)}` : `Changed ${listFiles(paths)}`
  }
  const region = focus(paths)
  return region !== undefined ? `Changed ${paths.length} files in ${region}` : `Changed ${paths.length} files`
}

const outcomeWord: Record<ValidationOutcome, string> = { passed: "passed", failed: "failed", unknown: "outcome unknown" }

/** "passed", or "passed (inferred)" when a judgment of the output supplied it. */
const resultWord = (run: ValidationRun): string =>
  `${outcomeWord[run.outcome]}${run.inferred !== undefined || run.kindInferred !== undefined ? " (inferred)" : ""}`

const sceneTitle = (kind: SceneKind, f: SceneFacts): string => {
  switch (kind) {
    case "read":
      return describeReads(f)
    case "change":
      return describeChanges(f)
    case "validate":
      return f.validation !== undefined
        ? `Ran ${validationLabel[f.validation.kind]} → ${resultWord(f.validation)}`
        : "Ran a check"
    case "command":
      if (f.commit !== undefined) return `Committed “${shortCommand(f.commit, 40)}”`
      if (f.commands.length === 1) return `Ran \`${shortCommand(f.commands[0]!, 36)}\``
      return f.commands.length > 1 ? `Ran ${f.commands.length} commands` : "Ran a command"
    case "conversation":
      return f.events.some((e) => e.type === "agent.message") ? "Replied without using tools" : "Conversation"
  }
}

const sceneDescription = (kind: SceneKind, f: SceneFacts): string | undefined => {
  if (kind === "validate" || kind === "command") return f.commands.map((c) => `$ ${shortCommand(c, 96)}`).join("\n") || undefined
  const files = kind === "change" ? f.changes : f.reads
  if (files.length > 2) return files.slice(0, 4).join(", ") + (files.length > 4 ? ` and ${files.length - 4} more` : "")
  return undefined
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

const phaseOf: Record<SceneKind, ChapterKind> = {
  read: "exploration",
  change: "implementation",
  validate: "validation",
  command: "other",
  conversation: "other"
}

interface Group {
  kind: ChapterKind
  scenes: Array<number>
}

/**
 * Group one prompt's scenes into phases. Debugging is a failed check, then changes,
 * then a re-run of that same check; a different check passing afterwards proves
 * nothing about the one that failed.
 */
const groupSegment = (indices: ReadonlyArray<number>, scenes: ReadonlyArray<ReplaySceneDraft>): Array<Group> => {
  const debugEnd = new Map<number, number>()
  for (let a = 0; a < indices.length; a++) {
    const failed = scenes[indices[a]!]!
    if (failed.kind !== "validate" || failed.facts.validation?.outcome !== "failed") continue
    const check = failed.facts.validation.check
    let end = a
    let changed = false
    for (let b = a + 1; b < indices.length; b++) {
      const scene = scenes[indices[b]!]!
      if (scene.kind === "change") changed = true
      if (scene.kind !== "validate" || scene.facts.validation?.check !== check) continue
      if (!changed) break
      end = b
      changed = false
      if (scene.facts.validation.outcome !== "failed") break
    }
    if (end > a) {
      debugEnd.set(a, end)
      a = end
    }
  }

  const groups: Array<Group> = []
  for (let a = 0; a < indices.length; a++) {
    const end = debugEnd.get(a)
    if (end !== undefined) {
      groups.push({ kind: "debugging", scenes: indices.slice(a, end + 1) })
      a = end
      continue
    }
    const index = indices[a]!
    const kind = phaseOf[scenes[index]!.kind]
    const last = groups.at(-1)
    if (last !== undefined && last.kind !== "debugging" && (last.kind === kind || kind === "other")) last.scenes.push(index)
    else if (last !== undefined && last.kind === "other" && last.scenes.every((i) => scenes[i]!.kind === "conversation")) {
      last.kind = kind
      last.scenes.push(index)
    } else groups.push({ kind, scenes: [index] })
  }

  const passed = (g: Group) => {
    const runs = g.scenes.flatMap((i) => scenes[i]!.facts.runs)
    return runs.length > 0 && runs.every((r) => r.outcome === "passed")
  }
  const small = (g: Group) => g.scenes.length === 1 && scenes[g.scenes[0]!]!.facts.reads.length + scenes[g.scenes[0]!]!.facts.commands.length <= 2
  return consolidate(groups, passed, small)
}

/**
 * Real sessions alternate quickly between reading, editing and checking. Without
 * consolidation every alternation becomes a chapter, which reads like a log again.
 */
const consolidate = (
  groups: Array<Group>,
  passed: (group: Group) => boolean,
  small: (group: Group) => boolean
): Array<Group> => {
  let changed = true
  while (changed) {
    changed = false
    for (let g = 0; g + 1 < groups.length; g++) {
      const [a, b, c] = [groups[g]!, groups[g + 1]!, groups[g + 2]]
      // Neighbours doing the same kind of work are one chapter.
      const same = a.kind === b.kind && a.kind !== "debugging"
      // A short look around between two stretches of editing is part of the editing.
      const sandwich = a.kind === "implementation" && b.kind === "exploration" && c?.kind === "implementation" &&
        b.scenes.length <= 2
      // A brief look around, or a lone command, prepares whatever comes next.
      const prelude = (a.kind === "exploration" || a.kind === "other") && small(a) && b.kind !== "debugging"
      // Editing followed by a short, passing check is one piece of work.
      const verified = a.kind === "implementation" && b.kind === "validation" && b.scenes.length <= 2 && passed(b)
      if (sandwich) {
        a.scenes.push(...b.scenes, ...c!.scenes)
        groups.splice(g + 1, 2)
      } else if (same || verified) {
        a.scenes.push(...b.scenes)
        groups.splice(g + 1, 1)
      } else if (prelude) {
        b.scenes.unshift(...a.scenes)
        groups.splice(g, 1)
      } else continue
      changed = true
      break
    }
  }
  return groups
}

interface ReplaySceneDraft {
  readonly kind: SceneKind
  readonly startsChapter: boolean
  readonly facts: SceneFacts
}

const chapterTitle = (kind: ChapterKind, members: ReadonlyArray<ReplaySceneDraft>, facts: SceneFacts): string => {
  switch (kind) {
    case "exploration":
      return members.length === 1 ? sceneTitle("read", facts) : describeReads(facts).replace(/^Read /, "Explored ")
    case "implementation":
      return describeChanges(facts)
    case "validation": {
      if (facts.runs.length === 1) return sceneTitle("validate", facts)
      const latest = latestByCheck(facts.runs)
      const labels = unique(latest.map((r) => validationLabel[r.kind]))
      const outcomes = unique(latest.map((r) => r.outcome))
      const inferred = latest.some((r) => r.inferred !== undefined) ? " (inferred)" : ""
      const verdict = outcomes.length === 1 ? outcomeWord[outcomes[0]!] : outcomes.includes("failed") ? "some failed" : "some unclear"
      return `Ran ${joinList(labels)} → ${verdict}${inferred}`
    }
    case "debugging": {
      // The chapter opens with the failed run; its last re-run decides the title.
      const first = facts.runs[0]!
      const last = facts.runs.findLast((r) => r.check === first.check)!
      const label = validationLabel[first.kind].replace(/^the /, "")
      const inferred = first.inferred !== undefined || last.inferred !== undefined ? " (inferred)" : ""
      return last.outcome === "passed"
        ? `Fixed failing ${label}${inferred}`
        : last.outcome === "failed"
        ? `Changed code; ${label} still failing${inferred}`
        : `Changed code and re-ran failing ${label}; result unclear`
    }
    case "other":
      return members.length === 1 ? sceneTitle(members[0]!.kind, facts) : facts.commit !== undefined
        ? "Committed changes"
        : facts.workCommands > 0
        ? `Ran ${plural(facts.workCommands, "command")}`
        : facts.commands.length > 0
        ? inspectionLabel(facts.commands)
        : "Conversation"
  }
}

/** The last run of each distinct check, in order of first appearance. */
export const latestByCheck = (runs: ReadonlyArray<ValidationRun>): ReadonlyArray<ValidationRun> => {
  const latest = new Map<string, ValidationRun>()
  for (const run of runs) latest.set(run.check, run)
  return [...latest.values()]
}

const joinList = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const chapterSummary = (facts: SceneFacts): string | undefined => {
  const parts: Array<string> = []
  if (facts.reads.length > 0) parts.push(`read ${plural(facts.reads.length, "file")}`)
  if (facts.changes.length > 0) parts.push(`changed ${plural(facts.changes.length, "file")}`)
  if (facts.workCommands > 0) {
    parts.push(`ran ${plural(facts.workCommands, "command")}${facts.failedWork > 0 ? ` (${facts.failedWork} failed)` : ""}`)
  }
  if (facts.failedInspections > 0) parts.push(`${plural(facts.failedInspections, "inspection command")} failed`)
  // The final state of each distinct check, so a passing lint never hides failing tests.
  for (const run of latestByCheck(facts.runs)) parts.push(`${validationLabel[run.kind]} ${resultWord(run)}`)
  if (parts.length === 0) return undefined
  const text = parts.join(", ")
  return text[0]!.toUpperCase() + text.slice(1)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const deriveStory = (
  events: ReadonlyArray<SessionEvent>,
  norm: Norm,
  judgments: Judgments = new Map(),
  kinds: CommandKinds = new Map()
): ReplayStory => {
  const steps = buildSteps(events, judgments, kinds)
  refine(steps)
  const drafts = buildScenes(steps)
  const sceneDrafts: Array<ReplaySceneDraft & { readonly steps: ReadonlyArray<Step> }> = drafts.map((d) => ({
    kind: d.kind,
    startsChapter: d.startsChapter,
    steps: d.steps,
    facts: factsOf(d.steps, norm)
  }))

  const segments: Array<Array<number>> = []
  sceneDrafts.forEach((d, i) => {
    if (d.startsChapter || segments.length === 0) segments.push([i])
    else segments.at(-1)!.push(i)
  })
  const groups = segments.flatMap((segment) => groupSegment(segment, sceneDrafts))

  const chapterOfScene = new Map<number, number>()
  groups.forEach((g, c) => g.scenes.forEach((s) => chapterOfScene.set(s, c)))

  const sceneByEvent = new Map<EventId, SceneId>()
  const scenes: Array<ReplayScene> = sceneDrafts.map((d, i) => {
    const id = sceneId(i)
    const f = d.facts
    for (const e of f.events) sceneByEvent.set(e.id, id)
    return {
      id,
      chapterId: chapterId(chapterOfScene.get(i)!),
      index: i,
      kind: d.kind,
      title: sceneTitle(d.kind, f),
      description: sceneDescription(d.kind, f),
      eventIds: f.events.map((e) => e.id),
      filePaths: unique([...f.changes, ...f.reads]),
      commandIds: unique(f.events.flatMap((e) => (e.type === "command.started" ? [e.commandId as CommandId] : []))),
      toolCallIds: unique(f.events.flatMap((e) => (e.type === "tool.started" ? [e.toolCallId as ToolCallId] : []))),
      startSequence: f.events[0]?.sequence ?? 0,
      endSequence: f.events.at(-1)?.sequence ?? 0,
      outcome: d.kind === "validate" ? f.validation?.outcome : undefined,
      check: d.kind === "validate" && f.validation !== undefined
        ? {
          kind: f.validation.kind,
          command: f.validation.check,
          commandId: f.validation.commandId,
          inferred: f.validation.inferred ?? f.validation.kindInferred
        }
        : undefined
    }
  })

  const chapters: Array<ReplayChapter> = groups.map((g, c): ReplayChapter => {
    const members = g.scenes.map((i) => sceneDrafts[i]!)
    const facts = factsOf(members.flatMap((m) => m.steps), norm)
    const prompt = facts.events.find((e) => e.type === "user.message")
    return {
      id: chapterId(c),
      index: c,
      title: chapterTitle(g.kind, members, facts),
      summary: chapterSummary(facts),
      promptEventId: prompt?.id,
      sceneIds: g.scenes.map((i) => scenes[i]!.id),
      eventIds: facts.events.map((e) => e.id),
      filePaths: unique([...facts.changes, ...facts.reads]),
      startSequence: facts.events[0]?.sequence ?? 0,
      endSequence: facts.events.at(-1)?.sequence ?? 0,
      kind: g.kind,
      // A chapter whose wording depends on an inferred result says so.
      derivation: facts.runs.some((r) => r.inferred !== undefined) ? "ai" : "deterministic"
    }
  })

  const checksToJudge = steps.flatMap((s) => (s.validation?.judgeable === true ? [s.validation.commandId] : []))
  // Commands the rules do not recognise but might be checks, not yet judged.
  const commandsToClassify = events.flatMap((e) =>
    e.type === "command.started" && !kinds.has(e.commandId) && classifyCommand(e.command).type === "other" &&
      checkCandidate(e.command) !== undefined
      ? [e.commandId as CommandId]
      : []
  )
  return { scenes, chapters, sceneByEvent, checksToJudge, commandsToClassify }
}

/** First line of a prompt, for chapter headers and session titles. */
export const promptText = (event: SessionEvent | undefined): string | undefined =>
  event?.type === "user.message" ? plainText(event.content).trim() || undefined : undefined

