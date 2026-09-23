import { encodeEventLine, type SessionEvent } from "@agentbridge/schema"
import { expect } from "@effect/vitest"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fixturesDir } from "./fixtures.ts"

/**
 * Compare canonical JSONL with a golden file (spec §62). Absolute fixture paths
 * are replaced with `$FIXTURES/` so goldens are machine independent.
 * Set `UPDATE_GOLDEN=1` to rewrite.
 */
export const expectGolden = (goldenPath: string, events: ReadonlyArray<SessionEvent>) => {
  const actual = events.map((event) => encodeEventLine(event).replaceAll(fixturesDir, "$FIXTURES/")).join("\n") + "\n"
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true })
    writeFileSync(goldenPath, actual)
  }
  expect(actual).toBe(readFileSync(goldenPath, "utf8"))
}
