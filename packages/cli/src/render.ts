import type { DetectionResult, ImportWarning, Session, SessionDescriptor, SessionEvent } from "@agentbridge/schema"
import { plainText } from "@agentbridge/schema"

/**
 * Human-readable rendering. Works only from canonical data: no harness IDs,
 * native tool names or provider formats are consulted here.
 */

const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const inferred = (certainty: string) => (certainty === "known" ? "" : ` (${certainty})`)

const time = (timestamp: string | undefined) => (timestamp === undefined ? "        " : timestamp.slice(11, 19))

export const renderEvent = (event: SessionEvent): string | undefined => {
  const at = `${String(event.sequence).padStart(4)} ${time(event.timestamp)}`
  switch (event.type) {
    case "session.started":
      return `${at} ▶ session started`
    case "session.completed":
      return `${at} ■ session completed (${event.certainty})`
    case "session.failed":
      return `${at} ✗ session failed ${event.message ?? ""}`
    case "user.message":
      return `${at} » user: ${oneLine(plainText(event.content))}`
    case "agent.message":
      return `${at} « agent: ${oneLine(plainText(event.content))}`
    case "agent.reasoning":
      return `${at} ~ reasoning (${event.representation}): ${oneLine(event.content, 100)}`
    case "harness.notice":
      return `${at} · notice [${event.kind}]: ${oneLine(plainText(event.content), 80)}`
    case "context.compacted":
      return `${at} ⇣ context compacted`
    case "turn.started":
      return `${at} ┌ turn ${event.turnId}`
    case "turn.completed":
      return `${at} └ turn ${event.outcome}${event.durationMs !== undefined ? ` in ${Math.round(event.durationMs / 1000)}s` : ""}`
    case "usage.recorded": {
      const input = (event.inputTokens ?? 0) + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0)
      return `${at}   ∑ ${input} in / ${event.outputTokens ?? 0} out tokens`
    }
    case "plan.updated": {
      const done = event.entries.filter((entry) => entry.status === "completed").length
      const current = event.entries.find((entry) => entry.status === "in_progress")
      return `${at} ☐ plan ${done}/${event.entries.length}${current ? `: ${oneLine(current.content, 80)}` : ""}`
    }
    case "tool.started":
      return `${at} ⚙ ${event.kind} tool ${event.name}`
    case "tool.completed":
      return undefined
    case "tool.failed":
      return `${at}   ✗ tool failed: ${oneLine(event.message, 100)}`
    case "command.started":
      return `${at}   $ ${oneLine(event.command, 140)}`
    case "command.completed":
      return `${at}   → ${event.outcome}${event.exitCode !== undefined ? ` (exit ${event.exitCode})` : ""}${
        event.durationMs !== undefined ? ` in ${event.durationMs}ms` : ""
      }`
    case "file.read":
      return `${at}   ◦ read ${event.path}${inferred(event.certainty)}`
    case "file.created":
      return `${at}   + created ${event.path}${inferred(event.certainty)}`
    case "file.changed":
      return `${at}   ± changed ${event.path}${inferred(event.certainty)}`
    case "file.deleted":
      return `${at}   - deleted ${event.path}${inferred(event.certainty)}`
    default:
      return `${at} ? ${event.type}`
  }
}

export const renderDescriptorRow = (d: SessionDescriptor) => {
  const when = d.updatedAt?.slice(0, 16).replace("T", " ") ?? "                "
  const size = (d.sizeBytes === undefined ? "db" : `${Math.max(1, Math.round(d.sizeBytes / 1024))}K`).padStart(6)
  const child = d.parentSessionId !== undefined ? `  ↳ ${d.agentLabel ?? "subagent"}` : ""
  return `${when} ${size}  ${d.id}  ${d.projectPath ?? ""}${child}`
}

export const renderSession = (session: Session, warnings: ReadonlyArray<ImportWarning>, eventCount: number) => {
  const lines = [
    `${session.title ?? "(untitled)"}`,
    `  id:        ${session.id}`,
    `  harness:   ${session.harness.name}${session.harness.version ? ` ${session.harness.version}` : ""}`,
    `  status:    ${session.status}`,
    ...(session.projectPath ? [`  project:   ${session.projectPath}`] : []),
    ...(session.parentSessionId ? [`  parent:    ${session.parentSessionId}`] : []),
    ...(session.startedAt ? [`  started:   ${session.startedAt}`] : []),
    ...(session.updatedAt ? [`  updated:   ${session.updatedAt}`] : []),
    `  events:    ${eventCount}`,
    `  supports:  ${
      Object.entries(session.capabilities)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .join(", ")
    }`
  ]
  if (warnings.length > 0) {
    lines.push(`  loaded with ${warnings.length} compatibility warning${warnings.length === 1 ? "" : "s"}:`)
    for (const w of warnings) lines.push(`    ! ${w.code}: ${w.message}${(w.count ?? 1) > 1 ? ` (×${w.count})` : ""}`)
  }
  return lines.join("\n")
}

export const renderDetection = (d: DetectionResult) => {
  const ok = d.installed || d.historyAvailable
  const lines = [`${ok ? "✓" : "○"} ${d.name} ${ok ? "detected" : "not detected"}`]
  if (ok) {
    lines.push(`  installed: ${d.installed ? "yes" : "no"}`)
    if (d.version) lines.push(`  version: ${d.version}`)
    lines.push(`  history: ${d.historyAvailable ? "available" : "not found"}`)
    for (const path of d.paths) lines.push(`  path: ${path}`)
  }
  for (const note of d.notes) lines.push(`  note: ${note}`)
  return lines.join("\n")
}
