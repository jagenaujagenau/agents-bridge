import { Bridge, gitEnricher, sourceFingerprint } from "@agentbridge/core"
import { NodeBridge } from "@agentbridge/platform-node"
import { type CommandCompleted, encodeEvent, Session } from "@agentbridge/schema"
import { fixtureBridgeOptions } from "@agentbridge/testing"
import { Effect, ManagedRuntime, Schema, Stream } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { homedir } from "node:os"
import { dirname } from "node:path"
import type { Plugin } from "vite"
import type { CheckJudgment, CommandKindJudgment, ReplyJudgment } from "../replay/model.ts"
import { replyTurns } from "../replay/turns.ts"
import { type SessionUsage, sessionUsage } from "../replay/usage.ts"
import { deriveReplay, sessionTitle } from "../replay/derive.ts"
import { type FamilyMember, familyMember } from "../fleet/model.ts"
import { checkCandidate, classifyCommand } from "../story/commands.ts"
import { type JevConfig, judgeCheck, judgeCommand, judgeReply, jevConfig, mapLimit, outputTail } from "./jev.ts"

/**
 * The browser cannot read local history, so the dev server exposes two read-only
 * JSON endpoints over the public Bridge API. Everything else, derivation included,
 * happens in the browser.
 *
 *   GET /api/sessions          descriptors, newest first
 *   GET /api/session?id=…      { session, warnings, events } in the canonical wire format
 *   GET /api/summaries?id=…&id=…  title, tokens spent and models used per session (cached on disk)
 *   GET /api/family?id=…&id=…     each session's scenes as fleet steps, derived here (compact)
 *   GET /api/titles?id=…&id=…     session titles (a full read each, so asked for a few at a time)
 *   GET /api/jev?id=…&command=…&reply=…  judgments of hidden check results and of closing replies (opt-in, see jev.ts)
 *
 * `REPLAY_FIXTURES=1` serves the checked-in fixtures instead of this machine's history.
 */

const fixtures = process.env.REPLAY_FIXTURES === "1"
const runtime = ManagedRuntime.make(NodeBridge.layer(fixtures ? fixtureBridgeOptions : { probeVersions: false }))
const encodeSession = Schema.encodeSync(Session)

const listSessions = Effect.gen(function*() {
  const bridge = yield* Bridge
  const sessions = yield* Stream.runCollect(bridge.sessions.list())
  return {
    source: fixtures ? "fixtures" : "local",
    // So the browser can show project paths as `~/…`.
    home: homedir(),
    harnesses: bridge.harnesses.list.map((h) => ({ id: h.id, name: h.name })),
    sessions: [...sessions].sort((a, b) => (b.updatedAt ?? b.startedAt ?? "").localeCompare(a.updatedAt ?? a.startedAt ?? ""))
  }
})

const getSession = (id: string) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const { session, warnings } = yield* bridge.sessions.get(id)
    const events = yield* Stream.runCollect(bridge.sessions.events(id, { enrichers: [gitEnricher], verifyGit: true }))
    return { session: encodeSession(session), warnings, events: [...events].map((e) => encodeEvent(e)) }
  })

let jev: JevConfig | undefined
// ponytail: in-memory cache for the life of the dev server; persist it if repeat cost matters.
const judged = new Map<string, CheckJudgment>()
const judgedReplies = new Map<string, ReplyJudgment>()
const judgedKinds = new Map<string, CommandKindJudgment>()
const MAX_CHECKS_PER_REQUEST = 200

/**
 * Judge the given checks of one session. Events are read again here, redacted, so only
 * masked output leaves the machine and the browser cannot choose what is sent.
 */
const judgeSession = (
  id: string,
  commandIds: ReadonlyArray<string>,
  replyIds: ReadonlyArray<string>,
  classifyIds: ReadonlyArray<string> = []
) =>
  Effect.gen(function*() {
    if (jev === undefined) return { enabled: false }
    const config = jev
    const bridge = yield* Bridge
    const events = [...yield* Stream.runCollect(bridge.sessions.events(id, { redact: true }))]
    const wanted = new Set(commandIds.slice(0, MAX_CHECKS_PER_REQUEST))
    const wantedReplies = new Set(replyIds.slice(0, MAX_CHECKS_PER_REQUEST))
    const turns = replyTurns(events).filter((t) => wantedReplies.has(t.replyEventId))
    const replyResults = yield* Effect.promise(() =>
      mapLimit(turns, 6, async (turn) => {
        const key = `${id}|reply|${turn.replyEventId}|${config.model}`
        if (!judgedReplies.has(key)) {
          const judgment = await judgeReply(config, turn).catch((error: unknown) => {
            console.warn(`[replay] Jev reply judgment failed for ${turn.replyEventId}: ${(error as Error).message}`)
            return undefined
          })
          if (judgment === undefined) return [turn.replyEventId, undefined] as const
          judgedReplies.set(key, judgment)
        }
        return [turn.replyEventId, judgedReplies.get(key)] as const
      })
    )
    const replies = Object.fromEntries(replyResults.filter(([, j]) => j !== undefined))
    const wantedCommands = new Set(classifyIds.slice(0, MAX_CHECKS_PER_REQUEST))
    const candidates = events.flatMap((e) => {
      if (e.type !== "command.started" || !wantedCommands.has(e.commandId)) return []
      const segment = checkCandidate(e.command)
      const done = events.find((c): c is CommandCompleted => c.type === "command.completed" && c.commandId === e.commandId)
      return segment === undefined ? [] : [{ commandId: e.commandId, command: e.command, segment, output: outputTail(done?.stdout, done?.stderr) }]
    })
    const kindResults = yield* Effect.promise(() =>
      mapLimit(candidates, 6, async (candidate) => {
        const key = `${id}|kind|${candidate.commandId}|${config.model}`
        if (!judgedKinds.has(key)) {
          const judgment = await judgeCommand(config, candidate).catch((error: unknown) => {
            console.warn(`[replay] Jev command judgment failed for ${candidate.commandId}: ${(error as Error).message}`)
            return undefined
          })
          if (judgment === undefined) return [candidate.commandId, undefined] as const
          judgedKinds.set(key, judgment)
        }
        return [candidate.commandId, judgedKinds.get(key)] as const
      })
    )
    const commandKinds = Object.fromEntries(kindResults.filter(([, j]) => j !== undefined))
    const completions = new Map<string, CommandCompleted>()
    for (const e of events) if (e.type === "command.completed") completions.set(e.commandId, e)
    const checks = events.flatMap((e) => {
      if (e.type !== "command.started" || !wanted.has(e.commandId)) return []
      const cls = classifyCommand(e.command)
      const done = completions.get(e.commandId)
      const output = outputTail(done?.stdout, done?.stderr)
      return cls.type === "validation" && cls.outputIsCheck && output !== "" ? [{ commandId: e.commandId, command: e.command, kind: cls.kind, output }] : []
    })
    const results = yield* Effect.promise(() =>
      mapLimit(checks, 6, async (check) => {
        const key = `${id}|${check.commandId}|${config.model}`
        if (!judged.has(key)) {
          // A failed call leaves the check unknown; it is not cached, so a reload retries it.
          const judgment = (await judgeCheck(config, check).catch((error: unknown) => {
            console.warn(`[replay] Jev judgment failed for ${check.commandId}: ${(error as Error).message}`)
            return undefined
          }))
          if (judgment === undefined) return [check.commandId, undefined] as const
          judged.set(key, judgment)
        }
        return [check.commandId, judged.get(key)] as const
      })
    )
    const judgments = Object.fromEntries(results.filter(([, j]) => j !== undefined))
    return {
      enabled: true,
      model: config.model,
      judgments,
      replies,
      commandKinds,
      failed: results.length - Object.keys(judgments).length + replyResults.length - Object.keys(replies).length +
        kindResults.length - Object.keys(commandKinds).length
    }
  })

/** What the session list shows beyond the listing: a title, and what the session spent. */
export interface SessionSummary {
  readonly title: string
  readonly usage: SessionUsage | null
}

// Summaries per session, keyed by session and source state and kept on disk: both need a full
// read of the session, and the home page asks for a page of them at once.
const USAGE_FILE = `${homedir()}/.bridge/replay-summaries.json`
let usageCache: Map<string, SessionSummary> | undefined
const usageCacheLoad = () => {
  if (usageCache !== undefined) return usageCache
  try {
    usageCache = new Map(Object.entries(JSON.parse(readFileSync(USAGE_FILE, "utf8")) as Record<string, SessionSummary>))
  } catch {
    usageCache = new Map()
  }
  return usageCache
}
let usageSaveTimer: ReturnType<typeof setTimeout> | undefined
const usageCacheSave = () => {
  clearTimeout(usageSaveTimer)
  usageSaveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(USAGE_FILE), { recursive: true })
      writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(usageCacheLoad())))
    } catch {
      // A missing cache only costs recomputation.
    }
  }, 500)
}

const getUsage = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const cache = usageCacheLoad()
    let changed = false
    const out = yield* Effect.forEach(ids.slice(0, 200), (id) =>
      Effect.gen(function*() {
        const key = `${id}|${sourceFingerprint(yield* bridge.sessions.describe(id))}`
        if (!cache.has(key)) {
          // Redacted: a title is often the first prompt.
          const { session } = yield* bridge.sessions.get(id, { redact: true })
          const events = [...yield* Stream.runCollect(bridge.sessions.events(id, { redact: true }))]
          cache.set(key, { title: sessionTitle(session, events), usage: sessionUsage(events) ?? null })
          changed = true
        }
        return [id, cache.get(key) ?? null] as const
      }).pipe(Effect.orElseSucceed(() => [id, null] as const)), { concurrency: 6 })
    if (changed) usageCacheSave()
    return { summaries: Object.fromEntries(out) }
  })

// Keyed by session and source state, so a growing session is derived again.
const members = new Map<string, FamilyMember>()

/**
 * A session family for the fleet: each agent's scenes with titles and times. Derived on the
 * server so the browser receives a few kilobytes instead of every event of every agent.
 * Redacted, since titles and scene names come from prompts and commands.
 */
const getFamily = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const out = yield* Effect.forEach(ids.slice(0, 100), (id) =>
      Effect.gen(function*() {
        const descriptor = yield* bridge.sessions.describe(id)
        const key = `${id}|${sourceFingerprint(descriptor)}`
        const cached = members.get(key)
        if (cached !== undefined) return [id, cached] as const
        const { session, warnings } = yield* bridge.sessions.get(id, { redact: true })
        const events = [...yield* Stream.runCollect(bridge.sessions.events(id, { redact: true }))]
        const member = familyMember(deriveReplay(session, events, warnings))
        members.set(key, member)
        return [id, member] as const
      }).pipe(Effect.orElseSucceed(() => [id, undefined] as const)), { concurrency: 6 })
    return { members: Object.fromEntries(out.filter(([, m]) => m !== undefined)) }
  })

// ponytail: in-memory; titles only change when a session is renamed, which history rarely records.
const titles = new Map<string, string | null>()

/** Titles for the fleet's spawn log. Redacted, since a title is usually the first prompt. */
const getTitles = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const bridge = yield* Bridge
    const missing = ids.slice(0, 50).filter((id) => !titles.has(id))
    yield* Effect.forEach(missing, (id) =>
      bridge.sessions.get(id, { redact: true }).pipe(
        Effect.map(({ session }) => titles.set(id, session.title ?? null)),
        Effect.orElseSucceed(() => titles.set(id, null))
      ), { concurrency: 6 })
    return { titles: Object.fromEntries(ids.slice(0, 50).map((id) => [id, titles.get(id) ?? null])) }
  })

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const id = url.searchParams.get("id")
  const route: Effect.Effect<unknown, unknown, Bridge> | undefined = url.pathname === "/api/sessions"
    ? listSessions
    : url.pathname === "/api/session" && id !== null
    ? getSession(id)
    : url.pathname === "/api/summaries"
    ? getUsage(url.searchParams.getAll("id"))
    : url.pathname === "/api/family"
    ? getFamily(url.searchParams.getAll("id"))
    : url.pathname === "/api/titles"
    ? getTitles(url.searchParams.getAll("id"))
    : url.pathname === "/api/jev" && id !== null
    ? judgeSession(id, url.searchParams.getAll("command"), url.searchParams.getAll("reply"), url.searchParams.getAll("classify"))
    : undefined
  if (route === undefined) return next()
  runtime.runPromise(route).then(
    (body) => send(res, 200, body),
    (error: unknown) => {
      const tag = (error as { _tag?: string })._tag
      send(res, tag === "SessionNotFound" ? 404 : 500, { error: tag ?? "Error", message: String((error as Error).message ?? error) })
    }
  )
}

export const bridgeApi = (env: Readonly<Record<string, string | undefined>> = process.env): Plugin => ({
  name: "replay-bridge-api",
  configResolved: () => {
    jev = jevConfig(env)
  },
  configureServer: (server) => void server.middlewares.use(handle),
  configurePreviewServer: (server) => void server.middlewares.use(handle)
})
