import { GitRepository } from "@agentbridge/core"
import { Duration, Effect, Layer, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

/**
 * `GitRepository` backed by the `git` binary. Arguments are passed as an array (no shell),
 * hashes are validated by the caller, and `core.fsmonitor` is disabled so inspecting a
 * repository named by session data never runs repository-configured programs.
 * Any failure (no git, no repository, timeout) reads as "not found".
 */
export const NodeGitRepository = Layer.effect(
  GitRepository,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const git = (directory: string, args: ReadonlyArray<string>) =>
      spawner.string(ChildProcess.make("git", ["-c", "core.fsmonitor=false", "-C", directory, ...args])).pipe(
        Effect.timeoutOption(Duration.seconds(10)),
        Effect.map(Option.getOrElse(() => "")),
        Effect.orElseSucceed(() => "")
      )
    return {
      hasCommit: (directory, commit) =>
        Effect.map(git(directory, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]), (out) => out.trim().length > 0),
      findCommit: (directory, subject, around, windowMs) =>
        Effect.map(
          git(directory, [
            "log",
            "--all",
            "--fixed-strings",
            `--grep=${subject}`,
            `--since=${new Date(around.getTime() - windowMs).toISOString()}`,
            `--until=${new Date(around.getTime() + windowMs).toISOString()}`,
            "--format=%H%x00%s"
          ]),
          (out) => {
            const match = out.split("\n").map((line) => line.split("\0")).find(([, s]) => s === subject)
            return match?.[0] ? Option.some({ commit: match[0] }) : Option.none()
          }
        )
    }
  })
)
