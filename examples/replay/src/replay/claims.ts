import type { EventId, SessionEvent } from "@agentbridge/schema"
import { validationLabel } from "../story/commands.ts"
import type { ReplayScene, ReplyJudgment, ValidationOutcome } from "./model.ts"
import { replyTurns } from "./turns.ts"

/**
 * What the agent said at the end of each request, next to what the session recorded.
 * The judgment only reads the reply; comparing a claim with the checks is code.
 */

/** Measured on labelled replies (README): every question agrees best at 0.5. */
export const CLAIM_THRESHOLD = 0.5

export interface TurnClaims {
  readonly promptEventId: EventId
  readonly replyEventId: EventId
  readonly says: {
    readonly done: boolean
    readonly testsPass: boolean
    readonly checksPass: boolean
    readonly openProblem: boolean
  }
  /** Claims the recorded checks contradict or cannot support. */
  readonly conflicts: ReadonlyArray<string>
  readonly model: string
}

const lastOutcome = (runs: ReadonlyArray<ReplayScene>): { outcome: ValidationOutcome; inferred: boolean } | undefined => {
  const last = runs.at(-1)
  return last === undefined ? undefined : { outcome: last.outcome ?? "unknown", inferred: last.check?.inferred !== undefined }
}

const conflict = (
  claim: string,
  noun: string,
  runs: ReadonlyArray<ReplayScene>
): string | undefined => {
  const last = lastOutcome(runs)
  if (last === undefined) return `Says ${claim}, but no ${noun} ran in this request.`
  if (last.outcome === "failed") return `Says ${claim}, but the last ${noun} run in this request failed${last.inferred ? " (inferred)" : ""}.`
  if (last.outcome === "unknown") return `Says ${claim}, but the result of the last ${noun} run was not recorded.`
  return undefined
}

export const assessTurns = (
  events: ReadonlyArray<SessionEvent>,
  scenes: ReadonlyArray<ReplayScene>,
  judgments: ReadonlyMap<string, ReplyJudgment>
): { readonly turns: ReadonlyArray<TurnClaims>; readonly toJudge: ReadonlyArray<EventId> } => {
  const turns: Array<TurnClaims> = []
  const toJudge: Array<EventId> = []
  const checks = scenes.filter((s) => s.check !== undefined)
  // A check belongs to the turn its command ran in.
  const ranAt = new Map<string, number>()
  for (const e of events) if (e.type === "command.started") ranAt.set(e.commandId, e.sequence)
  for (const turn of replyTurns(events)) {
    const judgment = judgments.get(turn.replyEventId)
    if (judgment === undefined) {
      toJudge.push(turn.replyEventId)
      continue
    }
    const inTurn = checks.filter((s) => {
      const at = ranAt.get(s.check!.commandId) ?? s.startSequence
      return at > turn.startSequence && at < turn.endSequence
    })
    const tests = inTurn.filter((s) => s.check!.kind === "tests")
    const others = inTurn.filter((s) => s.check!.kind !== "tests")
    const says = {
      done: judgment.done >= CLAIM_THRESHOLD,
      testsPass: judgment.testsPass >= CLAIM_THRESHOLD,
      checksPass: judgment.checksPass >= CLAIM_THRESHOLD,
      openProblem: judgment.openProblem >= CLAIM_THRESHOLD
    }
    const conflicts = [
      says.testsPass ? conflict("tests pass", "test", tests) : undefined,
      says.checksPass
        ? conflict(
          "the build, type check or lint passes",
          others.length > 0 ? validationLabel[others.at(-1)!.check!.kind].replace(/^the /, "") : "build, type check or lint",
          others
        )
        : undefined
    ].filter((c): c is string => c !== undefined)
    turns.push({ promptEventId: turn.promptEventId, replyEventId: turn.replyEventId, says, conflicts, model: judgment.model })
  }
  return { turns, toJudge }
}
