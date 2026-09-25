import type { EventId, SessionEvent, SessionId } from "@agentbridge/schema"
import { scenario } from "@agentbridge/testing"
import { NodeBridge } from "@agentbridge/platform-node"
import { fixtureBridgeOptions } from "@agentbridge/testing"
import { Bridge } from "@agentbridge/core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { modelLabel, vendorOf } from "../src/models/vendors.ts"
import { sessionUsage, usageTotal } from "../src/replay/usage.ts"
import { sessionTitle } from "../src/replay/derive.ts"
import type { Session } from "@agentbridge/schema"

const usage = (i: number, model: string | undefined, input: number, output: number, cacheRead = 0): SessionEvent => ({
  type: "usage.recorded",
  id: `evt_${i}` as EventId,
  sessionId: "t:1" as SessionId,
  sequence: i,
  certainty: "known",
  source: { provider: "t", format: "t" },
  ...(model !== undefined ? { model } : {}),
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead
})

describe("session usage", () => {
  it("sums every call and ranks models by the tokens they used", () => {
    const u = sessionUsage([
      usage(0, "model-a", 100, 10, 1000),
      usage(1, "model-b", 50, 5),
      usage(2, "model-a", 100, 10),
      usage(3, "<synthetic>", 0, 0),
      usage(4, undefined, 5, 1)
    ])!
    expect(u).toMatchObject({ input: 255, output: 26, cacheRead: 1000, cacheWrite: 0, calls: 5 })
    expect(usageTotal(u)).toBe(1281)
    // Placeholders and missing model names do not count as models.
    expect(u.models).toEqual([{ model: "model-a", tokens: 1220 }, { model: "model-b", tokens: 55 }])
  })

  it("is undefined for a session that recorded no usage", () => {
    expect(sessionUsage([])).toBeUndefined()
  })

  it.effect("reads the fixture sessions' usage through Bridge", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const u = sessionUsage(yield* Stream.runCollect(bridge.sessions.events(scenario.claude)))
      expect(u?.calls).toBeGreaterThan(0)
      expect(u?.models[0]?.model).toBeDefined()
    }).pipe(Effect.provide(NodeBridge.layer(fixtureBridgeOptions))))
})

describe("model vendors and labels", () => {
  it.each([
    ["claude-opus-5-5", "Anthropic", "Claude Opus 5.5"],
    ["claude-sonnet-4-5-20250929", "Anthropic", "Claude Sonnet 4.5"],
    ["gpt-5.4-mini", "OpenAI", "GPT-5.4 Mini"],
    ["deepseek-v4-pro", "DeepSeek", "DeepSeek V4 Pro"],
    ["qwen3.6-plus", "Qwen", "Qwen3.6 Plus"],
    ["google/gemma-4-e4b", "Google", "Gemma 4 E4B"],
    ["zai/glm-5.3-flash", "Z.ai", "GLM-5.3 Flash"]
  ])("%s → %s, %s", (model, vendor, label) => {
    expect(vendorOf(model).name).toBe(vendor)
    expect(modelLabel(model)).toBe(label)
  })

  it("leaves an unknown vendor's model name as recorded", () => {
    expect(vendorOf("big-pickle").id).toBe("unknown")
    expect(modelLabel("big-pickle")).toBe("big-pickle")
  })
})

describe("session titles", () => {
  const session = { id: "t:1", title: undefined } as unknown as Session
  const prompt = (text: string): SessionEvent => ({
    type: "user.message", id: "evt_p" as EventId, sessionId: "t:1" as SessionId, sequence: 0, certainty: "known",
    source: { provider: "t", format: "t" }, content: [{ type: "text", text }]
  })
  it("uses the session's own title, else the first line of its first prompt", () => {
    expect(sessionTitle({ ...session, title: "Named" } as Session, [prompt("ignored")])).toBe("Named")
    expect(sessionTitle({ ...session, title: "## Objective" } as Session, [])).toBe("Objective")
    expect(sessionTitle(session, [prompt("\n  Fix the login bug\nwith details")])).toBe("Fix the login bug")
    expect(sessionTitle(session, [prompt("# Objective\n\nShip it")])).toBe("Objective")
    expect(sessionTitle(session, [])).toBe("Untitled session")
  })
})
