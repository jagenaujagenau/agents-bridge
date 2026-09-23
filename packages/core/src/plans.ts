import type { Certainty, EventId, PlanEntry } from "@agentbridge/schema"
import type { RecordScope } from "./normalize.ts"
import { parseJson } from "./sources.ts"

// A provider-neutral decoder for the common list-shaped plan payload. Adapters
// select the native tool and list/text fields; core never interprets tool names.

const PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"])

/**
 * Map a native todo status to a plan status. `cancelled` entries leave the plan;
 * `blocked` is still outstanding work; a missing status means not started.
 */
const planStatus = (status: unknown): PlanEntry["status"] | "drop" | "invalid" => {
  if (status === undefined || status === null) return "pending"
  if (status === "pending" || status === "in_progress" || status === "completed") return status
  if (status === "cancelled" || status === "canceled") return "drop"
  if (status === "blocked") return "pending"
  return "invalid"
}

/** Normalize a native todo list. Returns `undefined` when the payload is not a list of entries. */
export const planEntries = (entries: unknown, contentKey: string): ReadonlyArray<PlanEntry> | undefined => {
  // Some harnesses store the list as a JSON string.
  const list = typeof entries === "string" ? parseJson(entries).pipe((o) => (o._tag === "Some" ? o.value : undefined)) : entries
  if (!Array.isArray(list)) return undefined
  const plan: Array<PlanEntry> = []
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) return undefined
    const entry = raw as Record<string, unknown>
    const content = entry[contentKey]
    const status = planStatus(entry["status"])
    if (status === "invalid") return undefined
    // Entries without text (e.g. a status-only update for an unseen item) cannot be shown.
    if (status === "drop" || typeof content !== "string" || content.length === 0) continue
    const priority = entry["priority"]
    plan.push({ content, status, ...(typeof priority === "string" && PRIORITIES.has(priority) ? { priority: priority as NonNullable<PlanEntry["priority"]> } : {}) })
  }
  return plan
}

export const emitPlan = (
  scope: RecordScope,
  entries: unknown,
  contentKey: string,
  link: { readonly parentEventId: EventId; readonly derivedFrom: ReadonlyArray<EventId>; readonly certainty: Certainty }
): boolean => {
  const plan = planEntries(entries, contentKey)
  if (plan === undefined) {
    scope.warning("malformed_record", "Skipped malformed plan updates")
    return false
  }
  scope.event({ type: "plan.updated", entries: plan, ...link })
  return true
}

/** Safely select the array inside a provider's tool input. */
export const planList = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined
