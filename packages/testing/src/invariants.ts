import { type SessionEvent, validateEvent } from "@agentbridge/schema"

/**
 * Structural invariants every adapter's event stream must satisfy (spec §65).
 * Returns a list of human-readable violations; empty means the stream is sound.
 */
export const checkEventInvariants = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const ids = new Set<string>()
  const toolsStarted = new Set<string>()
  const commandsStarted = new Set<string>()
  let openTurn: string | undefined
  const sessionIds = new Set(events.map((e) => e.sessionId))
  if (sessionIds.size > 1) problems.push(`events span several sessions: ${[...sessionIds].join(", ")}`)

  events.forEach((event, index) => {
    const at = `#${index} ${event.type}`
    try {
      validateEvent(JSON.parse(JSON.stringify(event)))
    } catch (error) {
      problems.push(`${at}: not a valid canonical event: ${String(error)}`)
    }
    if (event.sequence !== index) problems.push(`${at}: sequence ${event.sequence} is not ${index}`)
    if (ids.has(event.id)) problems.push(`${at}: duplicate id ${event.id}`)
    for (const ref of [event.parentEventId, ...(event.derivedFrom ?? [])]) {
      if (ref !== undefined && !ids.has(ref)) problems.push(`${at}: references ${ref}, which does not precede it`)
    }
    ids.add(event.id)

    switch (event.type) {
      case "session.started":
        if (index !== 0) problems.push(`${at}: session.started must be the first event`)
        break
      case "tool.started":
        toolsStarted.add(event.toolCallId)
        break
      case "tool.completed":
      case "tool.failed":
        if (!toolsStarted.has(event.toolCallId)) problems.push(`${at}: completes unknown tool ${event.toolCallId}`)
        break
      case "command.started":
        commandsStarted.add(event.commandId)
        break
      case "turn.started":
        if (openTurn !== undefined) problems.push(`${at}: turn ${event.turnId} starts while ${openTurn} is open`)
        openTurn = event.turnId
        break
      case "turn.completed":
        if (openTurn !== event.turnId) problems.push(`${at}: completes turn ${event.turnId}, open turn is ${openTurn ?? "none"}`)
        openTurn = undefined
        break
      case "command.completed":
        if (!commandsStarted.has(event.commandId)) {
          problems.push(`${at}: completes unknown command ${event.commandId}`)
        }
        if (event.outcome === "succeeded" && event.exitCode !== undefined && event.exitCode !== 0) {
          problems.push(`${at}: succeeded with exit code ${event.exitCode}`)
        }
        break
      default:
        break
    }
  })
  return problems
}

/** Patterns that must never appear in normalized output produced from sanitized fixtures. */
export const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"(?:accessToken|refreshToken|apiKey|api_key)"\s*:/
]
