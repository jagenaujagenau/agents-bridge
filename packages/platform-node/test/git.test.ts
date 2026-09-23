import { GitRepository } from "@agentbridge/core"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeGitRepository } from "../src/index.ts"

describe("NodeGitRepository", () => {
  it.live("finds commits by hash and by subject near a time", () => {
    const repo = mkdtempSync(join(tmpdir(), "bridge-git-"))
    const git = (...args: Array<string>) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
    git("init", "-q")
    writeFileSync(join(repo, "a.txt"), "a")
    git("add", "a.txt")
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "Add usage docs")
    const hash = git("rev-parse", "HEAD")
    return Effect.gen(function*() {
      const repository = yield* GitRepository
      expect(yield* repository.hasCommit(repo, hash.slice(0, 7))).toBe(true)
      expect(yield* repository.hasCommit(repo, "0000000")).toBe(false)
      expect(yield* repository.hasCommit("/nonexistent", hash)).toBe(false)
      const found = yield* repository.findCommit(repo, "Add usage docs", new Date(), 60_000)
      expect(Option.getOrUndefined(found)?.commit).toBe(hash)
      expect(Option.isNone(yield* repository.findCommit(repo, "Add usage", new Date(), 60_000))).toBe(true)
      expect(Option.isNone(yield* repository.findCommit(repo, "Add usage docs", new Date(Date.now() - 86_400_000), 60_000))).toBe(true)
    }).pipe(
      Effect.provide(NodeGitRepository.pipe(Layer.provide(NodeServices.layer))),
      Effect.ensuring(Effect.sync(() => rmSync(repo, { recursive: true, force: true })))
    )
  })
})
