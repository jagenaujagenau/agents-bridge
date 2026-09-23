import { type EventId, type SessionEvent, stableEventId } from "@agentbridge/schema"
import { Stream } from "effect"

/**
 * Enrichers (spec §41) are opt-in transformations of a canonical event stream.
 * Each call creates fresh per-session state; the returned step maps one event to
 * the events that replace it (itself, possibly changed, plus any derived events).
 * They run after normalization, so they never see provider data.
 */
export type SessionEnricher = () => (event: SessionEvent) => ReadonlyArray<SessionEvent>

/**
 * Apply enrichers in order and renumber `sequence` so it stays contiguous.
 * Returns a stateful step for one session; use `enrichStream` for streams.
 */
export const enrichment = (enrichers: ReadonlyArray<SessionEnricher>) => {
  const steps = enrichers.map((make) => make())
  let sequence = 0
  return (event: SessionEvent): ReadonlyArray<SessionEvent> =>
    steps
      .reduce<ReadonlyArray<SessionEvent>>((events, step) => events.flatMap(step), [event])
      .map((e) => (e.sequence === sequence ? (sequence++, e) : { ...e, sequence: sequence++ }))
}

export const enrichStream = (enrichers: ReadonlyArray<SessionEnricher>) =>
<E, R>(events: Stream.Stream<SessionEvent, E, R>): Stream.Stream<SessionEvent, E, R> =>
  enrichers.length === 0
    ? events
    : Stream.suspend(() => {
      const step = enrichment(enrichers)
      return events.pipe(Stream.flatMap((event) => Stream.fromIterable(step(event))))
    })

// ---------------------------------------------------------------------------
// Git (spec §42)
// ---------------------------------------------------------------------------

const GIT_COMMIT = /\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/
const COMMIT_LINE = /^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.*)$/m

/** `-m "msg"`, `-am 'msg'`, `-m msg`, `--message=msg`. */
const messageArgument = (command: string): string | undefined => {
  const match = /(?:\s-[a-zA-Z]*m|\s--message)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(command)
  return match ? (match[1] ?? match[2] ?? match[3])?.replace(/\\"/g, "\"") : undefined
}

/**
 * Derives `git.commit` from a `git commit` command that did not fail. The commit hash,
 * branch and message come from git's own output when it was recorded.
 */
export const gitEnricher: SessionEnricher = () => {
  const commands = new Map<string, Extract<SessionEvent, { type: "command.started" }>>()
  return (event) => {
    if (event.type === "command.started") {
      if (GIT_COMMIT.test(event.command)) commands.set(event.commandId, event)
      return [event]
    }
    if (event.type !== "command.completed") return [event]
    const started = commands.get(event.commandId)
    if (started === undefined) return [event]
    commands.delete(event.commandId)
    const output = `${event.stdout ?? ""}\n${event.stderr ?? ""}`
    if (event.outcome === "failed" || event.outcome === "interrupted" || /nothing (added )?to commit/.test(output)) {
      return [event]
    }
    const line = COMMIT_LINE.exec(event.stdout ?? "")
    const message = line?.[3] ?? messageArgument(started.command)
    const commit: SessionEvent = {
      type: "git.commit",
      id: stableEventId({
        harness: "bridge",
        sessionId: event.sessionId,
        nativeEventId: event.id,
        canonicalType: "git.commit",
        derivationIndex: 0
      }) as EventId,
      sessionId: event.sessionId,
      sequence: event.sequence,
      ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
      parentEventId: started.id,
      derivedFrom: [started.id, event.id],
      certainty: "inferred",
      source: event.source,
      ...(line ? { branch: line[1]!, commit: line[2]! } : {}),
      ...(message !== undefined ? { message } : {})
    }
    return [event, commit]
  }
}

// ---------------------------------------------------------------------------
// Redaction (spec §43)
// ---------------------------------------------------------------------------

const DETECTORS: ReadonlyArray<readonly [kind: string, pattern: RegExp, keep?: number]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["bearer-token", /(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, 1],
  // KEY=value lines, as in .env files and exported shell variables. The name is kept.
  [
    "env-secret",
    /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(["']?)[^\s"'#]{8,}\2/gm,
    1
  ]
]

/** Replace likely secrets in text. Heuristic: it reduces exposure, it cannot guarantee none. */
export const redactText = (text: string): string =>
  DETECTORS.reduce(
    (current, [kind, pattern, keep]) =>
      current.replace(pattern, (...match: Array<unknown>) => `${keep ? String(match[keep]) : ""}[REDACTED:${kind}]`),
    text
  )

/** Fields that identify or order events; never content, never redacted. */
const STRUCTURAL = new Set([
  "type",
  "id",
  "sessionId",
  "sequence",
  "timestamp",
  "parentEventId",
  "derivedFrom",
  "certainty",
  "source",
  "toolCallId",
  "commandId",
  "turnId",
  "kind",
  "outcome",
  "representation"
])

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactValue(inner)]))
  }
  return value
}

/** Redacts every content string of every event. Opt-in at read and export boundaries. */
export const redactionEnricher: SessionEnricher = () => (event) => [
  Object.fromEntries(
    Object.entries(event).map(([key, value]) => [key, STRUCTURAL.has(key) ? value : redactValue(value)])
  ) as SessionEvent
]
