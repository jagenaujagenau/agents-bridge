import type { SessionEvent } from "@agentbridge/schema"
import { Context, Effect, type Option } from "effect"

/**
 * Read-only access to git repositories on this machine, used to verify commits that
 * the git enricher derived from command output (spec §42). Platform implementations
 * live outside core; without one, derived commits simply stay `inferred`.
 */
export interface GitRepositoryShape {
  /** Whether `commit` names a commit in the repository at `directory`. */
  readonly hasCommit: (directory: string, commit: string) => Effect.Effect<boolean>
  /** A commit whose subject is exactly `subject`, committed within `windowMs` of `around`. */
  readonly findCommit: (
    directory: string,
    subject: string,
    around: Date,
    windowMs: number
  ) => Effect.Effect<Option.Option<{ readonly commit: string; readonly branch?: string | undefined }>>
}

export class GitRepository extends Context.Service<GitRepository, GitRepositoryShape>()(
  "@agentbridge/core/GitRepository"
) {}

const HASH = /^[0-9a-f]{7,40}$/
const WINDOW_MS = 60 * 60 * 1000

/**
 * Upgrade `git.commit` events to `known` when the repository at `projectPath` contains the
 * commit: by hash when git's output recorded one, else by exact subject near the event time.
 * Unverifiable commits (no repository, rewritten history) stay `inferred`, unchanged.
 */
export const verifyGitCommit = (git: GitRepositoryShape, projectPath: string | undefined) =>
(event: SessionEvent): Effect.Effect<SessionEvent> => {
  if (event.type !== "git.commit" || projectPath === undefined) return Effect.succeed(event)
  if (event.commit !== undefined) {
    if (!HASH.test(event.commit)) return Effect.succeed(event)
    return Effect.map(git.hasCommit(projectPath, event.commit), (found) =>
      found ? { ...event, certainty: "known" as const } : event)
  }
  if (event.message === undefined || event.timestamp === undefined) return Effect.succeed(event)
  // git matches on the subject line; the recorded message may include a body.
  const subject = event.message.trim().split("\n")[0]!.trim()
  return Effect.map(git.findCommit(projectPath, subject, new Date(event.timestamp), WINDOW_MS), (found) =>
    found._tag === "Some"
      ? {
        ...event,
        certainty: "known" as const,
        commit: found.value.commit,
        ...(found.value.branch !== undefined && event.branch === undefined ? { branch: found.value.branch } : {})
      }
      : event)
}
