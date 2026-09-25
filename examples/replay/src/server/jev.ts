import type { CheckJudgment, CommandKindJudgment, ReplyJudgment } from "../replay/model.ts"
import { validationLabel, type ValidationKind } from "../story/commands.ts"

/**
 * Judging hidden check results with Jev, TypeSafe's System One model.
 *
 * When a check's output goes through `tail` or `|| true`, the shell's exit status says
 * nothing about the check. The output usually does ("12 passed", "error TS2345"), so one
 * Choice question per check asks what it shows. Code keeps everything else: which checks
 * need judging, the confidence threshold, and how an inferred result is labelled.
 *
 * Opt-in: nothing is sent unless `REPLAY_JEV=1` and `TYPESAFE_API_KEY` are set. Output is
 * redacted by Bridge before it gets here.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"

export interface JevConfig {
  readonly apiKey: string
  readonly model: string
}

/**
 * The model the question wording and `MIN_JUDGMENT_CONFIDENCE` were measured against
 * (README, "Measured on"). `jev-latest` moves; re-run `eval:jev` before changing this.
 */
export const JEV_MODEL = "jev-1.13.0"

export const jevConfig = (env: Readonly<Record<string, string | undefined>> = process.env): JevConfig | undefined =>
  env.REPLAY_JEV === "1" && env.TYPESAFE_API_KEY
    ? { apiKey: env.TYPESAFE_API_KEY, model: env.REPLAY_JEV_MODEL ?? JEV_MODEL }
    : undefined

/** Results are printed last, and unrelated output is a distractor, so only the tail is sent. */
const MAX_LINES = 80
const MAX_CHARS = 6000

export const outputTail = (stdout: string | undefined, stderr: string | undefined): string => {
  const text = [stdout ?? "", stderr ?? ""].filter((s) => s.trim() !== "").join("\n")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
  const lines = text.trimEnd().split("\n").slice(-MAX_LINES).join("\n")
  return lines.length > MAX_CHARS ? lines.slice(-MAX_CHARS) : lines
}

const kindText: Record<ValidationKind, string> = {
  tests: "a test suite",
  typecheck: "a type check",
  lint: "a linter",
  build: "a build",
  checks: "a set of project checks"
}

/**
 * The request body for one check. The criteria spell out the boundaries (a check that
 * could not run failed; unrelated or cut-off output is unclear), because Jev reads
 * questions literally.
 */
export const checkRequest = (
  model: string,
  check: { readonly command: string; readonly kind: ValidationKind; readonly output: string }
) => ({
  model,
  state: {
    check: { command: check.command, runs: kindText[check.kind] },
    output: check.output
  },
  questions: {
    result: {
      type: "choice",
      instructions: {
        context: "`check.command` runs `check.runs` (" + validationLabel[check.kind] +
          "). The command pipes or chains its output, so its exit status does not tell whether the check passed. " +
          "Some checks, such as `tsc --noEmit`, print nothing when they succeed; `(no output)` means nothing was printed.",
        question: "Judging only from `output`, which is the end of what the command printed, what was the result of the check?"
      },
      criteria: {
        passed:
          "`output` shows the check ran to completion and succeeded: every test passed, the build finished, or no type, lint or compile errors were reported.",
        failed:
          "`output` shows the check did not succeed: at least one failing test, a compile, type or lint error, a crash, or the check could not run at all (for example command not found or a missing dependency). " +
          "Warnings and informational messages alone, such as `warning TS…` or `message TS…` lines, are not failures.",
        unclear:
          "`output` does not show the check's result: it is cut off before a result, only shows text unrelated to the check, " +
          "or mixes the output of several commands so the check's own result cannot be told apart. " +
          "If `check.command` filters the output (for example with `grep`) down to some tests or files, and `output` does not " +
          "show the result of the whole check, the result is unclear."
      }
    }
  }
})

interface ChoiceAnswer {
  readonly type: "choice"
  readonly choice: string
  readonly probabilities: Record<string, number>
  readonly confidence: number
}

export class JevError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface NoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

type Answer = ChoiceAnswer | NoulAnswer

/** One System One request. Retries rate limits and overload with backoff, as the API docs ask. */
const ask = async (
  config: JevConfig,
  body: { readonly model: string; readonly state: unknown; readonly questions: object },
  fetchImpl: typeof fetch
): Promise<{ readonly model: string; readonly answers: Readonly<Record<string, Answer | undefined>> }> => {
  for (let attempt = 0;; attempt++) {
    const response = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    if ((response.status === 429 || response.status === 529) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      continue
    }
    if (!response.ok) throw new JevError(response.status, `TypeSafe API ${response.status}: ${await response.text()}`)
    return await response.json() as { model: string; answers: Record<string, Answer> }
  }
}

/** One check, one request. */
export const judgeCheck = async (
  config: JevConfig,
  check: { readonly command: string; readonly kind: ValidationKind; readonly output: string },
  fetchImpl: typeof fetch = fetch
): Promise<CheckJudgment> => {
  const body = await ask(config, checkRequest(config.model, check), fetchImpl)
  const answer = body.answers.result
  if (answer?.type !== "choice" || !["passed", "failed", "unclear"].includes(answer.choice)) {
    throw new JevError(502, "TypeSafe API returned an unexpected answer")
  }
  return {
    outcome: answer.choice as CheckJudgment["outcome"],
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    model: body.model
  }
}

// ---------------------------------------------------------------------------
// What the agent said it did
// ---------------------------------------------------------------------------

/** Replies are long; claims about results usually close them, so the end is kept. */
const MAX_REPLY_CHARS = 4000
const MAX_REQUEST_CHARS = 1500

const clipStart = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)
const clipEnd = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * Four yes/no questions about the agent's closing reply to a request, asked together
 * over the same state. They record what the agent *said*; code compares that with the
 * checks the session recorded.
 */
export const replyRequest = (model: string, turn: { readonly request: string; readonly reply: string }) => ({
  model,
  state: { request: clipEnd(turn.request, MAX_REQUEST_CHARS), reply: clipStart(turn.reply, MAX_REPLY_CHARS) },
  questions: {
    done: {
      type: "noul",
      instructions: "Does `reply` say that the work asked for in `request` is finished?",
      criteria: {
        true: "`reply` says the requested work is done, complete, implemented or fixed.",
        false:
          "`reply` says the work is partial, blocked or not started, only describes a plan or findings, or asks the user a question before continuing."
      }
    },
    testsPass: {
      type: "noul",
      instructions: "Does `reply` state that tests pass?",
      criteria: {
        true: "`reply` explicitly says tests pass, are green, or succeeded.",
        false: "`reply` does not say tests pass: it does not mention tests, says tests fail, or says tests were not run."
      }
    },
    checksPass: {
      type: "noul",
      instructions: "Does `reply` state that a build, type check or linter passes?",
      criteria: {
        true: "`reply` explicitly says the build succeeds, the type check is clean, or lint passes.",
        false: "`reply` does not say any build, type check or lint passes."
      }
    },
    openProblem: {
      type: "noul",
      instructions: "Does `reply` report something that is failing, broken or blocked right now?",
      criteria: {
        true:
          "`reply` says a test, build or feature still fails or is broken, an error remains unresolved, or the work cannot continue because of a blocker such as missing access, a missing tool or a missing file.",
        false:
          "`reply` reports nothing failing or blocked. Describing what the agent is doing or will do next, work awaiting review or approval, suggestions, and questions to the user are not problems."
      }
    }
  }
})

export const replyClaims = ["done", "testsPass", "checksPass", "openProblem"] as const
export type ReplyClaim = (typeof replyClaims)[number]

export const judgeReply = async (
  config: JevConfig,
  turn: { readonly request: string; readonly reply: string },
  fetchImpl: typeof fetch = fetch
): Promise<ReplyJudgment> => {
  const body = await ask(config, replyRequest(config.model, turn), fetchImpl)
  const out: Partial<Record<ReplyClaim, number>> = {}
  for (const claim of replyClaims) {
    const answer = body.answers[claim]
    if (answer?.type !== "noul") throw new JevError(502, "TypeSafe API returned an unexpected answer")
    out[claim] = answer.noul
  }
  return { ...(out as Record<ReplyClaim, number>), model: body.model }
}

// ---------------------------------------------------------------------------
// Commands the rules do not recognise
// ---------------------------------------------------------------------------

export const commandKinds = ["tests", "typecheck", "lint", "build", "checks", "not_a_check"] as const

/**
 * Whether a shortlisted command (see `checkCandidate`) checks the project's code, and how.
 * The output helps: a smoke script that prints "ok" differs from a server that starts.
 */
export const commandRequest = (
  model: string,
  candidate: { readonly command: string; readonly segment: string; readonly output: string }
) => ({
  model,
  state: {
    command: clipEnd(candidate.command, 1000),
    candidate: candidate.segment,
    output: candidate.output.split("\n").slice(-30).join("\n")
  },
  questions: {
    kind: {
      type: "choice",
      instructions:
        "`candidate` is part of the shell command `command`, and `output` is the end of what the command printed. " +
        "Does `candidate` check the project's code, and if so, how?",
      criteria: {
        tests: "`candidate` runs automated tests, or a smoke test that verifies the project behaves correctly.",
        typecheck: "`candidate` type-checks the project's code without running it.",
        lint: "`candidate` runs a linter, a formatting check or static analysis.",
        build: "`candidate` compiles, bundles or packages the project.",
        checks: "`candidate` runs several of these checks together, such as a CI, verify or pre-commit script.",
        not_a_check:
          "`candidate` does something else: runs or serves the application, runs a one-off or data script, deploys, installs, or calls a helper or maintenance tool."
      }
    }
  }
})

export const judgeCommand = async (
  config: JevConfig,
  candidate: { readonly command: string; readonly segment: string; readonly output: string },
  fetchImpl: typeof fetch = fetch
): Promise<CommandKindJudgment> => {
  const body = await ask(config, commandRequest(config.model, candidate), fetchImpl)
  const answer = body.answers.kind
  if (answer?.type !== "choice" || !(commandKinds as ReadonlyArray<string>).includes(answer.choice)) {
    throw new JevError(502, "TypeSafe API returned an unexpected answer")
  }
  return {
    kind: answer.choice as CommandKindJudgment["kind"],
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: body.model
  }
}

// ---------------------------------------------------------------------------
// Narration that announces a new step
// ---------------------------------------------------------------------------

/** Whether a mid-turn message announces that the agent is moving on to a different step. */
export const narrationRequest = (model: string, message: string) => ({
  model,
  state: { message: clipStart(message, 1500) },
  questions: {
    transition: {
      type: "noul",
      instructions: "Does `message` announce that the agent is moving on to a different step of its work?",
      criteria: {
        true:
          "`message` says what the agent will do next and it is a new step, for example \"Now let me run the tests\", \"Next, I'll update the parser\" or \"That's fixed. Moving on to the docs.\"",
        false:
          "`message` continues the current step, comments on a result, explains a finding, or asks a question, without starting a different step."
      }
    }
  }
})

export const judgeNarration = async (config: JevConfig, message: string, fetchImpl: typeof fetch = fetch): Promise<number> => {
  const body = await ask(config, narrationRequest(config.model, message), fetchImpl)
  const answer = body.answers.transition
  if (answer?.type !== "noul") throw new JevError(502, "TypeSafe API returned an unexpected answer")
  return answer.noul
}

/** Run `work` over `items` with at most `limit` in flight. */
export const mapLimit = async <A, B>(items: ReadonlyArray<A>, limit: number, work: (a: A) => Promise<B>): Promise<Array<B>> => {
  const out = new Array<B>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
