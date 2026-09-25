import { ImportWarning, Session, SessionDescriptor, SessionEvent } from "@agentbridge/schema"
import { Effect, Schema, Stream } from "effect"
import { buildReplaySession } from "../replay/derive.ts"
import type { CheckJudgment, CommandKindJudgment, ReplaySession, ReplyJudgment } from "../replay/model.ts"
import type { FamilyMember } from "../fleet/model.ts"
import type { SessionUsage } from "../replay/usage.ts"

/** Client for the dev server's Bridge endpoints (see src/server/api.ts). */

const Listing = Schema.Struct({
  source: Schema.String,
  home: Schema.optionalKey(Schema.String),
  harnesses: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  sessions: Schema.Array(SessionDescriptor)
})
export type Listing = typeof Listing.Type

const Payload = Schema.Struct({
  session: Session,
  warnings: Schema.Array(ImportWarning),
  events: Schema.Array(SessionEvent)
})

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url)
  const body = await response.json() as { message?: string }
  if (!response.ok) throw new Error(body.message ?? `${response.status} ${response.statusText}`)
  return body
}

const Member = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  scenes: Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    title: Schema.String,
    eventCount: Schema.Number,
    start: Schema.optionalKey(Schema.Number),
    end: Schema.optionalKey(Schema.Number),
    failed: Schema.Boolean,
    times: Schema.optionalKey(Schema.Array(Schema.Number))
  }))
})
const Family = Schema.Struct({ members: Schema.Record(Schema.String, Member) })

/** A session family's scenes, derived by the dev server (see `/api/family`). */
export const fetchFamily = async (ids: ReadonlyArray<string>): Promise<ReadonlyMap<string, FamilyMember>> => {
  const params = new URLSearchParams(ids.map((id) => ["id", id] as [string, string]))
  return new Map(Object.entries(Schema.decodeUnknownSync(Family)(await fetchJson(`/api/family?${params}`)).members))
}

const UsageSchema = Schema.Struct({
  models: Schema.Array(Schema.Struct({ model: Schema.String, tokens: Schema.Number })),
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
  calls: Schema.Number
})
const SummarySchema = Schema.Struct({ title: Schema.String, usage: Schema.NullOr(UsageSchema) })
const SummariesResponse = Schema.Struct({ summaries: Schema.Record(Schema.String, Schema.NullOr(SummarySchema)) })

export interface SessionSummary {
  readonly title: string
  /** `null` where the session recorded no usage. */
  readonly usage: SessionUsage | null
}

/** Title, tokens and models per session; `null` where a session could not be read. */
export const fetchSummaries = async (ids: ReadonlyArray<string>): Promise<Readonly<Record<string, SessionSummary | null>>> => {
  if (ids.length === 0) return {}
  const params = new URLSearchParams(ids.map((id) => ["id", id] as [string, string]))
  return Schema.decodeUnknownSync(SummariesResponse)(await fetchJson(`/api/summaries?${params}`)).summaries
}

const Titles = Schema.Struct({ titles: Schema.Record(Schema.String, Schema.NullOr(Schema.String)) })

export const fetchTitles = async (ids: ReadonlyArray<string>): Promise<Readonly<Record<string, string | null>>> => {
  if (ids.length === 0) return {}
  const params = new URLSearchParams(ids.map((id) => ["id", id] as [string, string]))
  return Schema.decodeUnknownSync(Titles)(await fetchJson(`/api/titles?${params}`)).titles
}

export const fetchListing = async (): Promise<Listing> => Schema.decodeUnknownSync(Listing)(await fetchJson("/api/sessions"))

const Judgment = Schema.Struct({
  outcome: Schema.Literals(["passed", "failed", "unclear"]),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
  model: Schema.String
})

const ReplyJudgmentSchema = Schema.Struct({
  done: Schema.Number,
  testsPass: Schema.Number,
  checksPass: Schema.Number,
  openProblem: Schema.Number,
  model: Schema.String
})

const CommandKindSchema = Schema.Struct({
  kind: Schema.Literals(["tests", "typecheck", "lint", "build", "checks", "not_a_check"]),
  confidence: Schema.Number,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  model: Schema.String
})

const JudgmentsResponse = Schema.Struct({
  enabled: Schema.Boolean,
  model: Schema.optionalKey(Schema.String),
  judgments: Schema.optionalKey(Schema.Record(Schema.String, Judgment)),
  replies: Schema.optionalKey(Schema.Record(Schema.String, ReplyJudgmentSchema)),
  commandKinds: Schema.optionalKey(Schema.Record(Schema.String, CommandKindSchema)),
  failed: Schema.optionalKey(Schema.Number)
})

export interface JudgmentResult {
  readonly enabled: boolean
  readonly judgments: ReadonlyMap<string, CheckJudgment>
  readonly replies: ReadonlyMap<string, ReplyJudgment>
  readonly commandKinds: ReadonlyMap<string, CommandKindJudgment>
  readonly failed: number
}

/** Ask the dev server to judge hidden check results and closing replies. Batched to keep URLs short. */
export const fetchJudgments = async (
  id: string,
  commandIds: ReadonlyArray<string>,
  replyIds: ReadonlyArray<string> = [],
  classifyIds: ReadonlyArray<string> = []
): Promise<JudgmentResult> => {
  const judgments = new Map<string, CheckJudgment>()
  const replies = new Map<string, ReplyJudgment>()
  const commandKinds = new Map<string, CommandKindJudgment>()
  const items = [
    ...commandIds.map((c) => ["command", c] as [string, string]),
    ...replyIds.map((r) => ["reply", r] as [string, string]),
    ...classifyIds.map((c) => ["classify", c] as [string, string])
  ]
  let failed = 0
  for (let i = 0; i < items.length; i += 40) {
    const params = new URLSearchParams([["id", id], ...items.slice(i, i + 40)])
    const body = Schema.decodeUnknownSync(JudgmentsResponse)(await fetchJson(`/api/jev?${params}`))
    if (!body.enabled) return { enabled: false, judgments, replies, commandKinds, failed: 0 }
    for (const [commandId, judgment] of Object.entries(body.judgments ?? {})) judgments.set(commandId, judgment)
    for (const [replyId, judgment] of Object.entries(body.replies ?? {})) replies.set(replyId, judgment)
    for (const [commandId, judgment] of Object.entries(body.commandKinds ?? {})) commandKinds.set(commandId, judgment)
    failed += body.failed ?? 0
  }
  return { enabled: true, judgments, replies, commandKinds, failed }
}

export const fetchReplay = async (id: string): Promise<ReplaySession> => {
  const payload = Schema.decodeUnknownSync(Payload)(await fetchJson(`/api/session?id=${encodeURIComponent(id)}`))
  return Effect.runPromise(buildReplaySession(payload.session, Stream.fromIterable(payload.events), payload.warnings))
}
