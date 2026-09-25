import type { SessionEvent } from "@agentbridge/schema"
import { isRealModel } from "../models/vendors.ts"

/**
 * What a session spent, from its canonical `usage.recorded` events (each a per-call delta):
 * token totals, and every model that did work, heaviest first.
 */
export interface SessionUsage {
  readonly models: ReadonlyArray<{ readonly model: string; readonly tokens: number }>
  /** Input not served from a cache. */
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** All generated tokens, reasoning included. */
  readonly output: number
  readonly calls: number
}

export const usageTotal = (u: SessionUsage): number => u.input + u.cacheRead + u.cacheWrite + u.output

/** `undefined` when the session recorded no usage at all (some harnesses never do). */
export const sessionUsage = (events: Iterable<SessionEvent>): SessionUsage | undefined => {
  let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, calls = 0
  const byModel = new Map<string, number>()
  for (const e of events) {
    if (e.type !== "usage.recorded") continue
    const tokens = (e.inputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0) + (e.outputTokens ?? 0)
    input += e.inputTokens ?? 0
    cacheRead += e.cacheReadTokens ?? 0
    cacheWrite += e.cacheWriteTokens ?? 0
    output += e.outputTokens ?? 0
    calls++
    if (isRealModel(e.model)) byModel.set(e.model, (byModel.get(e.model) ?? 0) + tokens)
  }
  if (calls === 0) return undefined
  const models = [...byModel].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
  return { models, input, cacheRead, cacheWrite, output, calls }
}
