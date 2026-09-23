import { plainText, type Session, type SessionEvent } from "@agentbridge/schema"

/**
 * The semantic projection used by cross-adapter equivalence tests (spec §63).
 *
 * It keeps what a consumer would call "what happened" and drops what legitimately
 * differs between harnesses: IDs, sequence numbers, timestamps, provenance,
 * certainty, native tool names, reasoning representation and injected notices.
 *
 * It is written against the canonical model only. It must never look at
 * `harness.id`, `source.provider` or native tool names.
 */
export type SemanticStep =
  | readonly ["user", string]
  | readonly ["agent", string]
  | readonly ["read", string]
  | readonly ["created" | "changed" | "written" | "deleted", string]
  | readonly ["command", string, string]

export const relativeTo = (root: string | undefined, path: string): string => {
  if (root === undefined) return path
  const prefix = root.endsWith("/") ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export interface ProjectionOptions {
  /**
   * `exact` keeps created vs changed. `coarse` reports both as `written`, for comparing
   * with harnesses whose write tools do not record whether the file existed.
   */
  readonly writes?: "exact" | "coarse"
}

export const semanticProjection = (
  session: Pick<Session, "projectPath">,
  events: ReadonlyArray<SessionEvent>,
  options: ProjectionOptions = {}
): ReadonlyArray<SemanticStep> => {
  const coarse = options.writes === "coarse"
  // A command whose only observable effect was reading a file is represented by that read.
  const readCommands = new Set<string>()
  for (const event of events) {
    if (event.type === "file.read" && event.parentEventId !== undefined) readCommands.add(event.parentEventId)
  }
  const commandStarts = new Map<string, { readonly id: string; readonly command: string }>()
  const path = (value: string) => relativeTo(session.projectPath, value)

  const steps: Array<SemanticStep> = []
  for (const event of events) {
    switch (event.type) {
      case "user.message":
        steps.push(["user", plainText(event.content)])
        break
      case "agent.message":
        steps.push(["agent", plainText(event.content)])
        break
      case "file.read":
        steps.push(["read", path(event.path)])
        break
      case "file.created":
        steps.push([coarse ? "written" : "created", path(event.path)])
        break
      case "file.changed":
        steps.push([coarse ? "written" : "changed", path(event.path)])
        break
      case "file.deleted":
        steps.push(["deleted", path(event.path)])
        break
      case "command.started":
        commandStarts.set(event.commandId, { id: event.id, command: event.command })
        break
      case "command.completed": {
        const started = commandStarts.get(event.commandId)
        if (started !== undefined && !readCommands.has(started.id)) {
          steps.push(["command", started.command, event.outcome])
        }
        break
      }
      default:
        break
    }
  }
  return steps
}
