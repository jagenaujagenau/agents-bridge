import {
  activePath,
  bashStatus,
  type CommandStatus,
  emitUsage,
  emitUserCommand,
  idFromFileName,
  normalizeLine as normalizePiLine,
  type OpenTool,
  type PiDialect,
  type PiRecord,
  type PiState,
  recordScope,
  type ToolLink,
  type ToolResultFacts
} from "@agentbridge/adapter-pi"
import { type DecodedRecord, type Emission, emitPlan, makeLineDecoder, type RecordScope, stringProp, textOf } from "@agentbridge/core"
import { makeSessionId, type ToolKind } from "@agentbridge/schema"
import { KNOWN_TYPES, METADATA_TYPES, OmpRecord } from "./schema/OmpRecord.ts"

export const HARNESS = "omp"
export const NAME = "oh-my-pi"
export const FORMAT = "omp-session-jsonl"

// ---------------------------------------------------------------------------
// Tool vocabulary (the only place native omp tool names are interpreted)
// ---------------------------------------------------------------------------

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  ast_edit: "edit",
  bash: "execute",
  eval: "execute",
  grep: "search",
  search: "search",
  glob: "search",
  find: "search",
  ast_grep: "search",
  web_search: "search",
  todo: "think",
  think: "think"
}

export const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? "other"

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined

/** omp records the exit code in `details` when a command fails, and the trailer pi uses in the text. */
export const ompCommandStatus = (result: ToolResultFacts): CommandStatus | undefined => {
  const details = record(result.details)
  // A backgrounded command: this result only says it started.
  if (record(details?.["async"])?.["state"] === "running") return undefined
  const exitCode = integer(details?.["exitCode"])
  if (exitCode !== undefined) return { outcome: exitCode === 0 ? "succeeded" : "failed", exitCode }
  if (details?.["timedOut"] === true) return { outcome: "interrupted" }
  return bashStatus(result.text, result.failed)
}

/** A `read` path with its inline selector (`:10-20`, `:raw`, …) removed; internal URLs are not files. */
export const readTarget = (path: string | undefined): string | undefined => {
  if (path === undefined || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined
  return path.replace(/(?::(?:raw|conflicts|img|-?\d[\d,+-]*))+$/i, "")
}

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/** One file an `edit` call changed, from its result details (or a `perFileResults` entry). */
const emitEditedFile = (s: RecordScope, file: Record<string, unknown>, fallbackPath: string | undefined, link: ToolLink) => {
  if (file["isError"] === true) return
  const path = stringProp(file, "path") ?? fallbackPath
  if (path === undefined) return
  const diff = stringProp(file, "diff")
  const withDiff = diff ? { diff } : {}
  switch (file["op"]) {
    case "create":
      s.event({ type: "file.created", certainty: "known", path, ...withDiff, ...link })
      return
    case "delete":
      s.event({ type: "file.deleted", certainty: "known", path, ...link })
      return
    default: {
      const previousPath = stringProp(file, "sourcePath")
      s.event({ type: "file.changed", certainty: "known", path, ...(previousPath ? { previousPath } : {}), ...withDiff, ...link })
    }
  }
}

/** omp's todo result holds the whole list as phases of tasks. */
const todoEntries = (phases: unknown): unknown =>
  Array.isArray(phases)
    ? phases.flatMap((phase) => {
      const tasks = record(phase)?.["tasks"]
      return Array.isArray(tasks)
        ? tasks.map((task) => {
          const entry = record(task)
          // `abandoned` tasks leave the plan, like cancelled ones elsewhere.
          return entry?.["status"] === "abandoned" ? { ...entry, status: "cancelled" } : task
        })
        : [undefined]
    })
    : undefined

export const ompToolEffects = (s: RecordScope, tool: OpenTool, result: ToolResultFacts, link: ToolLink): void => {
  if (result.failed) return
  const details = record(result.details)
  switch (tool.name) {
    case "read": {
      // A delimited multi-path read lists what it resolved; otherwise the requested path.
      const links = strings(details?.["displayReadTargetLinks"])
      const paths = links.length > 0
        ? links
        : [readTarget(stringProp(tool.input, "path")) ?? stringProp(details, "resolvedPath")].filter((p) => p !== undefined)
      for (const path of paths) s.event({ type: "file.read", certainty: "known", path, ...link })
      return
    }
    case "write": {
      const path = readTarget(stringProp(tool.input, "path"))
      // `write` does not record whether the file existed.
      if (path !== undefined) s.event({ type: "file.changed", certainty: "known", path, ...link })
      return
    }
    case "edit": {
      // Every edit mode (hashline, replace, patch, apply_patch) reports the files it changed.
      const files = Array.isArray(details?.["perFileResults"]) ? details["perFileResults"] : details ? [details] : []
      for (const file of files) {
        const entry = record(file)
        if (entry !== undefined) emitEditedFile(s, entry, stringProp(tool.input, "path"), link)
      }
      return
    }
    case "ast_edit": {
      if (details?.["applied"] !== true || !Array.isArray(details["fileReplacements"])) return
      for (const file of details["fileReplacements"]) {
        const path = stringProp(file, "path")
        if (path !== undefined && (integer(record(file)?.["count"]) ?? 1) > 0) {
          s.event({ type: "file.changed", certainty: "known", path, ...link })
        }
      }
      return
    }
    case "todo": {
      if (details === undefined || details["op"] === "view" || details["phases"] === undefined) return
      emitPlan(s, todoEntries(details["phases"]), "content", { ...link, certainty: "known" })
      return
    }
  }
}

export const ompDialect: PiDialect = {
  harness: HARNESS,
  name: NAME,
  format: FORMAT,
  toolKind,
  shellCommand: (name, input) => (name === "bash" ? stringProp(input, "command") : undefined),
  commandStatus: ompCommandStatus,
  toolEffects: ompToolEffects
}

export const decodeLine = makeLineDecoder({ schema: OmpRecord, known: KNOWN_TYPES, ignored: METADATA_TYPES })

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/** The tree shape of one entry, read before normalizing. */
export interface TreeEntry {
  readonly id: string
  readonly parentId: string | undefined
  readonly type: string | undefined
  /** `model_usage` only: the leaf when late usage was recorded (`null`: no leaf). */
  readonly activeLeafId?: string | null | undefined
}

const selects = (entry: TreeEntry): string | null =>
  entry.type === "model_usage" && entry.activeLeafId !== undefined ? entry.activeLeafId : entry.id

/**
 * omp's `resolveSessionLeafId`: the last entry selects itself, except late `model_usage`, which
 * restores the leaf captured when it was written; a captured leaf that no longer exists falls back
 * to the newest self-selecting entry.
 */
export const resolveLeaf = (entries: ReadonlyArray<TreeEntry>): string | null | undefined => {
  const last = entries.at(-1)
  if (last === undefined) return undefined
  const leaf = selects(last)
  if (leaf === null || leaf === last.id || entries.some((entry) => entry.id === leaf)) return leaf
  return entries.findLast((entry) => selects(entry) === entry.id)?.id ?? null
}

/**
 * Entries on the active branch, or `undefined` when all are. Late usage hangs off the entry that
 * started the call, beside the branch that continued; it is kept when that entry is on the branch.
 * Title changes are session-level and always kept. A `null` leaf (omp shows an empty session) keeps
 * everything rather than hiding recorded work.
 */
export const ompActivePath = (entries: ReadonlyArray<TreeEntry>): ReadonlySet<string> | undefined => {
  const leaf = resolveLeaf(entries)
  if (leaf === null || leaf === undefined) return undefined
  const path = activePath(entries.map((entry) => [entry.id, entry.parentId] as const), leaf)
  if (path === undefined) return undefined
  const kept = new Set(path)
  for (const entry of entries) {
    if (entry.type === "title_change") kept.add(entry.id)
    if (entry.type === "model_usage" && (entry.parentId === undefined || kept.has(entry.parentId))) kept.add(entry.id)
  }
  return kept.size === entries.length ? undefined : kept
}

/** Whether a decoded line belongs to the active branch. The title slot, header and ID-less lines always do. */
export const onPath = (path: ReadonlySet<string> | undefined) => (line: DecodedRecord<OmpRecord>): boolean =>
  path === undefined || line._tag !== "Record" || line.record.type === "session" || line.record.type === "title" ||
  line.record.id === undefined || path.has(line.record.id)

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

type Step = readonly [PiState, ReadonlyArray<Emission>]

/** `provider/modelId` → `modelId`. */
const modelId = (model: string): string => model.slice(model.indexOf("/") + 1)

/**
 * Normalize one omp line. Records shaped like pi's go through pi's normalizer with omp's dialect;
 * this handles what omp adds. `subagent`: the file is a subagent transcript, whose header's
 * `parentSession` names the spawning session rather than a fork source.
 */
export const normalizeLine = (subagent: boolean) => (state: PiState, line: DecodedRecord<OmpRecord>): Step => {
  if (line._tag !== "Record") return normalizePiLine(state, line)
  const entry = line.record
  const s = recordScope(state, line.index, entry.type === "title" ? undefined : entry)
  switch (entry.type) {
    case "title":
      if (entry.title) s.metadata({ title: { value: entry.title, priority: 45 } })
      return [state, s.emissions]
    case "session": {
      if (state.headerSeen) return [state, []]
      const parent = !subagent && entry.parentSession ? idFromFileName(entry.parentSession) : undefined
      s.metadata({
        ...(entry.cwd !== undefined ? { projectPath: entry.cwd } : {}),
        ...(entry.title ? { title: { value: entry.title, priority: 40 } } : {}),
        ...(entry.version !== undefined ? { metadata: { sessionFormatVersion: entry.version } } : {}),
        ...(parent !== undefined
          ? { relationships: [{ type: "fork", from: state.sessionId, to: makeSessionId(HARNESS, parent) }] }
          : {})
      })
      s.event({ type: "session.started", certainty: "known" })
      return [{ ...state, headerSeen: true, cwd: entry.cwd }, s.emissions]
    }
    case "model_change":
      // Other roles (`smol`, `slow`, the ephemeral `fallback`) select models for side work.
      if (entry.model !== undefined && (entry.role === undefined || entry.role === "default")) {
        s.metadata({ metadata: { model: modelId(entry.model) } })
      }
      return [state, s.emissions]
    case "model_usage":
      emitUsage(s, entry.model, entry.usage)
      return [state, s.emissions]
    case "title_change":
      s.metadata({ title: { value: entry.title, priority: 50 } })
      return [state, s.emissions]
    case "message": {
      const message = entry.message
      switch (message.role) {
        case "developer": {
          const text = textOf(message.content)
          if (text.length > 0) {
            s.event({ type: "harness.notice", certainty: "known", kind: "injected_context", content: [{ type: "text", text }] })
          }
          return [state, s.emissions]
        }
        case "pythonExecution":
          emitUserCommand(state, s, { ...message, command: message.code, shell: "python" })
          return [state, s.emissions]
        case "fileMention": {
          const paths = (message.files ?? []).map((file) => `@${file.path}`)
          if (paths.length > 0) {
            s.event({ type: "harness.notice", certainty: "known", kind: "injected_context", content: [{ type: "text", text: paths.join("\n") }] })
          }
          return [state, s.emissions]
        }
        case "user":
          if (message.synthetic === true) {
            const text = textOf(message.content)
            if (text.length > 0) {
              s.event({ type: "harness.notice", certainty: "known", kind: "injected_context", content: [{ type: "text", text }] })
            }
            return [state, s.emissions]
          }
          break
      }
      return normalizePiLine(state, line as DecodedRecord<PiRecord>)
    }
    default:
      return normalizePiLine(state, line as DecodedRecord<PiRecord>)
  }
}

