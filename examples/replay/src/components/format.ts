import { plainText, type SessionEvent } from "@agentbridge/schema"

/** Display helpers shared by views. Canonical event types only. */

export const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return "—"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export const formatTime = (timestamp: string | undefined): string =>
  timestamp === undefined ? "" : new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })

export const formatDate = (timestamp: string | undefined): string =>
  timestamp === undefined ? "" : new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })

const clip = (text: string, max = 140) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Glyph and one-line text for an event. */
export const describeEvent = (e: SessionEvent, rel: (p: string) => string = (p) => p): readonly [string, string] => {
  switch (e.type) {
    case "user.message":
      return ["»", clip(plainText(e.content))]
    case "agent.message":
      return ["«", clip(plainText(e.content))]
    case "agent.reasoning":
      return ["~", clip(e.content)]
    case "harness.notice":
      return ["·", `${e.kind.replace("_", " ")}: ${clip(plainText(e.content), 100)}`]
    case "tool.started":
      return ["⚙", `${e.kind} · ${e.name}`]
    case "tool.updated":
      return ["⚙", `updated${e.name !== undefined ? ` · ${e.name}` : ""}`]
    case "tool.completed":
      return ["✓", "tool completed"]
    case "tool.failed":
      return ["✗", clip(e.message)]
    case "command.started":
      return ["$", clip(e.command)]
    case "command.completed":
      return [e.outcome === "failed" ? "✗" : "→", `${e.outcome}${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ""}`]
    case "file.read":
      return ["◦", `read ${rel(e.path)}`]
    case "file.created":
      return ["+", `created ${rel(e.path)}`]
    case "file.changed":
      return ["±", `changed ${rel(e.path)}`]
    case "file.deleted":
      return ["−", `deleted ${rel(e.path)}`]
    case "plan.updated":
      return ["☰", `plan · ${e.entries.length} entries`]
    case "usage.recorded":
      return ["∑", `${e.inputTokens ?? 0} in / ${e.outputTokens ?? 0} out tokens${e.model !== undefined ? ` · ${e.model}` : ""}`]
    case "turn.started":
      return ["┌", "turn started"]
    case "turn.completed":
      return ["└", `turn ${e.outcome}`]
    case "git.commit":
      return ["⎇", `commit ${e.commit?.slice(0, 7) ?? ""} ${e.message ?? ""}`.trim()]
    case "context.compacted":
      return ["⋯", "context compacted"]
    case "session.started":
      return ["▶", "session started"]
    case "session.completed":
      return ["■", "session completed"]
    case "session.failed":
      return ["✗", `session failed${e.message !== undefined ? `: ${e.message}` : ""}`]
    default:
      return ["?", e.type]
  }
}
