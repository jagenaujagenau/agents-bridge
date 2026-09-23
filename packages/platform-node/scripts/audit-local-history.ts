/**
 * Normalize every session found on this machine and report aggregate health:
 * event type counts, import warnings and structural invariant violations.
 * Prints counts and session IDs only, never session content.
 *
 *   pnpm audit:local
 */
import { Bridge } from "@agentbridge/core"
import { checkEventInvariants } from "@agentbridge/testing"
import { Effect, Stream } from "effect"
import { NodeBridge } from "../src/index.ts"

interface HarnessStats {
  sessions: number
  events: number
  unreadable: number
  withViolations: number
  warnings: Record<string, number>
  eventTypes: Record<string, number>
}

const program = Effect.gen(function*() {
  const bridge = yield* Bridge
  const started = Date.now()
  const descriptors = yield* Stream.runCollect(bridge.sessions.list())
  const stats: Record<string, HarnessStats> = {}
  const violations: Array<string> = []

  for (const descriptor of descriptors) {
    const s = (stats[descriptor.harness] ??= {
      sessions: 0,
      events: 0,
      unreadable: 0,
      withViolations: 0,
      warnings: {},
      eventTypes: {}
    })
    s.sessions++
    const result = yield* Effect.result(
      Effect.all([bridge.sessions.get(descriptor.id), Stream.runCollect(bridge.sessions.events(descriptor.id))])
    )
    if (result._tag === "Failure") {
      s.unreadable++
      violations.push(`${descriptor.id}: ${result.failure._tag}`)
      continue
    }
    const [loaded, events] = result.success
    s.events += events.length
    for (const event of events) s.eventTypes[event.type] = (s.eventTypes[event.type] ?? 0) + 1
    for (const warning of loaded.warnings) {
      s.warnings[warning.code] = (s.warnings[warning.code] ?? 0) + (warning.count ?? 1)
    }
    const problems = checkEventInvariants(events)
    if (problems.length > 0) {
      s.withViolations++
      violations.push(`${descriptor.id}: ${problems.length} violations, first: ${problems[0]}`)
    }
  }

  console.log(JSON.stringify(stats, null, 2))
  console.log(`\n${descriptors.length} sessions in ${Date.now() - started}ms`)
  if (violations.length > 0) {
    console.log(`\n${violations.length} sessions with problems:`)
    for (const line of violations.slice(0, 50)) console.log(`  ${line}`)
    process.exitCode = 1
  }
})

program.pipe(Effect.provide(NodeBridge.layer({ probeVersions: false })), Effect.runPromise)
