import type { CommandCompleted, CommandStarted, EventId } from "@agentbridge/schema"
import type { ReplayScene, ReplaySession } from "../replay/model.ts"
import { formatDuration } from "./format.ts"

/**
 * Commands reconstructed from canonical command events (GOAL §24). Relative to the
 * cursor a command is pending, running or completed; nothing is typed out.
 */

interface Props {
  readonly replay: ReplaySession
  readonly scene: ReplayScene
  readonly cursorSequence: number
  readonly onSeek: (eventId: EventId) => void
}

export const Terminal = ({ replay, scene, cursorSequence, onSeek }: Props) => {
  const events = scene.eventIds.map((id) => replay.eventIndex.eventById.get(id)!)
  const completions = new Map<string, CommandCompleted>()
  for (const e of events) if (e.type === "command.completed") completions.set(e.commandId, e)
  const commands = events.filter((e): e is CommandStarted => e.type === "command.started")

  if (commands.length === 0) return <p className="muted">No commands in this scene.</p>
  return (
    <div className="terminal">
      {commands.map((started) => {
        const done = completions.get(started.commandId)
        const phase = started.sequence > cursorSequence
          ? "pending"
          : done === undefined || done.sequence > cursorSequence
          ? "running"
          : "completed"
        const duration = done?.durationMs ?? started.durationMs ??
          (done?.timestamp !== undefined && started.timestamp !== undefined
            ? Date.parse(done.timestamp) - Date.parse(started.timestamp)
            : undefined)
        const outcome = phase === "completed" ? done!.outcome : phase
        // A check whose exit status the shell hid may carry a judgment of its output.
        const inferred = phase === "completed" && scene.check?.commandId === started.commandId ? scene.check.inferred : undefined
        return (
          <div
            key={started.id}
            className={`terminal__cmd is-${phase} outcome-${outcome}`}
            role="button"
            tabIndex={0}
            aria-label={`${started.command.split("\n")[0]}: ${outcome}`}
            onClick={() => onSeek(started.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onSeek(started.id)
              }
            }}
          >
            <div className="terminal__head">
              <span className="terminal__prompt">{started.cwd !== undefined ? `${started.cwd} ` : ""}$</span>
              <span className="terminal__status">
                {outcome}
                {phase === "completed" && done!.exitCode !== undefined ? ` · exit ${done!.exitCode}` : ""}
                {phase === "completed" && duration !== undefined ? ` · ${formatDuration(duration)}` : ""}
              </span>
            </div>
            {inferred !== undefined && (
              <div className="terminal__inferred">
                Check {scene.outcome} · inferred from output by {inferred.model}, confidence {inferred.confidence.toFixed(2)}
              </div>
            )}
            <pre className="terminal__command">{started.command}</pre>
            {phase === "completed" && done!.stdout !== undefined && done!.stdout !== "" && (
              <pre className="terminal__out">{done!.stdout}</pre>
            )}
            {phase === "completed" && done!.stderr !== undefined && done!.stderr !== "" && (
              <pre className="terminal__out is-err">{done!.stderr}</pre>
            )}
          </div>
        )
      })}
    </div>
  )
}
