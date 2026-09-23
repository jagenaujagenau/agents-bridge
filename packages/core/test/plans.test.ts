import { describe, expect, it } from "@effect/vitest"
import { planEntries } from "../src/index.ts"

describe("planEntries", () => {
  it("normalizes native todo variants", () => {
    expect(planEntries([
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "blocked" },
      { content: "c" },
      { content: "d", status: "cancelled" },
      { id: "x", status: "pending" }
    ], "content")).toEqual([
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" }
    ])
    expect(planEntries(JSON.stringify([{ step: "s", status: "in_progress" }]), "step")).toEqual([{ content: "s", status: "in_progress" }])
    expect(planEntries([{ content: "a", status: "weird" }], "content")).toBeUndefined()
    expect(planEntries("not json", "content")).toBeUndefined()
  })
})
