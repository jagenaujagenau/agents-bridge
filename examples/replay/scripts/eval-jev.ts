/**
 * Evaluate Jev's judgments of hidden check results against labels you trust.
 *
 *   node examples/replay/scripts/eval-jev.ts collect [file] [--limit N]
 *       Gather every check on this machine whose result the shell hid and whose output
 *       was recorded (redacted), one JSON line each with `"label": null`. Default file:
 *       ~/.bridge/replay-jev-eval.jsonl, outside the repository, since it holds your
 *       sessions' output.
 *
 *   node examples/replay/scripts/eval-jev.ts collect-replies [file]
 *       Every request and the agent's closing reply, with `"labels": null`. Label a sample
 *       with {"done", "testsPass", "checksPass", "openProblem"} booleans.
 *       Default file: ~/.bridge/replay-jev-replies.jsonl.
 *
 *   REPLAY_JEV=1 TYPESAFE_API_KEY=… node examples/replay/scripts/eval-jev.ts run-replies [file]
 *       Agreement per question and threshold on the labelled replies.
 *
 *   REPLAY_JEV=1 TYPESAFE_API_KEY=… node examples/replay/scripts/eval-jev.ts run [file]
 *       Judge every line whose `label` is "passed", "failed" or "unclear", and report
 *       agreement at several confidence thresholds. The costly mistake is showing a
 *       failed check as passed, so that count is reported on its own.
 */
import { Bridge } from "@agentbridge/core"
import { NodeBridge } from "@agentbridge/platform-node"
import type { CommandCompleted } from "@agentbridge/schema"
import { Effect, Stream } from "effect"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import type { CheckJudgment } from "../src/replay/model.ts"
import {
  commandKinds,
  jevConfig,
  judgeCheck,
  judgeCommand,
  judgeNarration,
  judgeReply,
  mapLimit,
  outputTail,
  type ReplyClaim,
  replyClaims
} from "../src/server/jev.ts"
import { narrationMessages, replyTurns } from "../src/replay/turns.ts"
import { checkCandidate, classifyCommand, type ValidationKind } from "../src/story/commands.ts"

interface Case {
  readonly sessionId: string
  readonly commandId: string
  readonly command: string
  readonly kind: ValidationKind
  readonly output: string
  readonly label: "passed" | "failed" | "unclear" | null
}

const [mode, ...rest] = process.argv.slice(2)
const replies = mode === "collect-replies" || mode === "run-replies"
const commands = mode === "collect-commands" || mode === "run-commands"
const narration = mode === "collect-narration" || mode === "run-narration"
const file = rest.find((a) => !a.startsWith("--")) ??
  `${homedir()}/.bridge/${
    replies ? "replay-jev-replies" : commands ? "replay-jev-commands" : narration ? "replay-jev-narration" : "replay-jev-eval"
  }.jsonl`
const limitAt = rest.indexOf("--limit")
const limit = limitAt >= 0 ? Number(rest[limitAt + 1]) : Infinity

const collect = Effect.gen(function*() {
  const bridge = yield* Bridge
  const sessions = [...yield* Stream.runCollect(bridge.sessions.list())]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "")
  let count = 0
  for (const descriptor of sessions) {
    if (count >= limit) break
    const events = yield* Stream.runCollect(bridge.sessions.events(descriptor.id, { redact: true })).pipe(
      Effect.orElseSucceed(() => [])
    )
    const done = new Map<string, CommandCompleted>()
    for (const e of events) if (e.type === "command.completed") done.set(e.commandId, e)
    for (const e of events) {
      if (e.type !== "command.started" || count >= limit) continue
      const cls = classifyCommand(e.command)
      if (cls.type !== "validation" || cls.exitReflectsCheck || !cls.outputIsCheck) continue
      const output = outputTail(done.get(e.commandId)?.stdout, done.get(e.commandId)?.stderr)
      if (output === "") continue
      const row: Case = { sessionId: descriptor.id, commandId: e.commandId, command: e.command, kind: cls.kind, output, label: null }
      appendFileSync(file, `${JSON.stringify(row)}\n`)
      count++
    }
  }
  console.log(`Wrote ${count} cases to ${file}. Set each "label" to passed, failed or unclear, then run the evaluation.`)
})

const run = async () => {
  const config = jevConfig()
  if (config === undefined) throw new Error("Set REPLAY_JEV=1 and TYPESAFE_API_KEY to run the evaluation.")
  if (!existsSync(file)) throw new Error(`No cases at ${file}; run collect first.`)
  const cases = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Case)
    .filter((c) => c.label !== null)
  // Mirror what Replay asks: only checks whose output is their own.
  const asked = cases.filter((c) => {
    const cls = classifyCommand(c.command)
    return cls.type === "validation" && cls.outputIsCheck
  })
  console.log(`${cases.length - asked.length} labelled cases skipped: output mixed with later commands, never sent.`)
  if (asked.length === 0) throw new Error(`No labelled cases in ${file}.`)
  const judged = await mapLimit(asked, 6, async (c) => [c, await judgeCheck(config, c)] as const)

  const model = judged[0]?.[1].model
  console.log(`${judged.length} labelled cases · ${model}\n`)
  console.log("threshold  shown  agree  wrong  failed-shown-as-passed")
  for (const threshold of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    // Mirrors the derivation: unclear or low-confidence judgments leave the result unknown.
    const shown = judged.filter(([, j]) => j.outcome !== "unclear" && j.confidence >= threshold)
    const agree = shown.filter(([c, j]) => c.label === j.outcome).length
    const falsePass = shown.filter(([c, j]) => c.label === "failed" && j.outcome === "passed").length
    console.log(
      `${threshold.toFixed(1).padStart(9)}  ${String(shown.length).padStart(5)}  ${String(agree).padStart(5)}  ` +
        `${String(shown.length - agree).padStart(5)}  ${String(falsePass).padStart(22)}`
    )
  }
  // Where it works and where it doesn't: by harness and by kind of check.
  for (const [name, key] of [["harness", (c: Case) => c.sessionId.split(":")[0]!], ["check", (c: Case) => c.kind]] as const) {
    const groups = new Map<string, { n: number; shown: number; agree: number }>()
    for (const [c, j] of judged) {
      const g = groups.get(key(c)) ?? { n: 0, shown: 0, agree: 0 }
      g.n++
      if (j.outcome !== "unclear" && j.confidence >= 0.6) {
        g.shown++
        if (j.outcome === c.label) g.agree++
      }
      groups.set(key(c), g)
    }
    console.log(`\nby ${name} (threshold 0.6): cases  shown  agree`)
    for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${k.padEnd(14)} ${String(g.n).padStart(5)}  ${String(g.shown).padStart(5)}  ${String(g.agree).padStart(5)}`)
    }
  }
  const confusion = new Map<string, number>()
  for (const [c, j] of judged) confusion.set(`${c.label} → ${j.outcome}`, (confusion.get(`${c.label} → ${j.outcome}`) ?? 0) + 1)
  console.log("\nlabel → answer (any confidence)")
  for (const [k, n] of [...confusion].sort()) console.log(`  ${k.padEnd(20)} ${n}`)
  const misses = judged.filter(([c, j]: readonly [Case, CheckJudgment]) => c.label !== j.outcome && j.outcome !== "unclear")
  if (misses.length > 0) {
    console.log("\nDisagreements (label vs answer, confidence):")
    for (const [c, j] of misses) console.log(`  ${c.label} vs ${j.outcome} ${j.confidence.toFixed(2)}  ${c.command.split("\n")[0]!.slice(0, 70)}`)
  }
}

interface ReplyCase {
  readonly sessionId: string
  readonly replyEventId: string
  readonly request: string
  readonly reply: string
  readonly labels: Record<ReplyClaim, boolean> | null
}

const collectReplies = Effect.gen(function*() {
  const bridge = yield* Bridge
  const sessions = [...yield* Stream.runCollect(bridge.sessions.list())]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "")
  let count = 0
  for (const descriptor of sessions) {
    const events = yield* Stream.runCollect(bridge.sessions.events(descriptor.id, { redact: true })).pipe(
      Effect.orElseSucceed(() => [])
    )
    for (const turn of replyTurns([...events])) {
      const row: ReplyCase = { sessionId: descriptor.id, replyEventId: turn.replyEventId, request: turn.request, reply: turn.reply, labels: null }
      appendFileSync(file, `${JSON.stringify(row)}\n`)
      count++
    }
  }
  console.log(`Wrote ${count} replies to ${file}.`)
})

const runReplies = async () => {
  const config = jevConfig()
  if (config === undefined) throw new Error("Set REPLAY_JEV=1 and TYPESAFE_API_KEY to run the evaluation.")
  const cases = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as ReplyCase)
    .filter((c) => c.labels !== null)
  if (cases.length === 0) throw new Error(`No labelled replies in ${file}.`)
  const judged = await mapLimit(cases, 6, async (c) => [c, await judgeReply(config, c)] as const)
  console.log(`${judged.length} labelled replies · ${judged[0]?.[1].model}\n`)
  console.log("question      threshold  said-yes  agree  false-yes  false-no")
  for (const claim of replyClaims) {
    for (const threshold of [0.5, 0.7, 0.9]) {
      let agree = 0, falseYes = 0, falseNo = 0, yes = 0
      for (const [c, j] of judged) {
        const predicted = j[claim] >= threshold
        const truth = c.labels![claim]
        if (predicted) yes++
        if (predicted === truth) agree++
        else if (predicted) falseYes++
        else falseNo++
      }
      console.log(`${claim.padEnd(13)} ${threshold.toFixed(1).padStart(9)}  ${String(yes).padStart(8)}  ${String(agree).padStart(5)}  ${String(falseYes).padStart(9)}  ${String(falseNo).padStart(8)}`)
    }
  }
  const misses = judged.flatMap(([c, j]) =>
    replyClaims.filter((k) => (j[k] >= 0.7) !== c.labels![k]).map((k) => `  ${k.padEnd(12)} label ${c.labels![k]} · p=${j[k].toFixed(2)} · ${c.reply.replace(/\s+/g, " ").slice(-90)}`)
  )
  if (misses.length > 0) console.log(`\nDisagreements at 0.7:\n${misses.join("\n")}`)
}

interface CommandCase {
  readonly sessionId: string
  readonly commandId: string
  readonly command: string
  readonly segment: string
  readonly output: string
  readonly label: (typeof commandKinds)[number] | null
}

const collectCommands = Effect.gen(function*() {
  const bridge = yield* Bridge
  const sessions = [...yield* Stream.runCollect(bridge.sessions.list())]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "")
  let count = 0
  for (const descriptor of sessions) {
    const events = yield* Stream.runCollect(bridge.sessions.events(descriptor.id, { redact: true })).pipe(
      Effect.orElseSucceed(() => [])
    )
    const done = new Map<string, CommandCompleted>()
    for (const e of events) if (e.type === "command.completed") done.set(e.commandId, e)
    for (const e of events) {
      if (e.type !== "command.started") continue
      const segment = checkCandidate(e.command)
      if (segment === undefined) continue
      const output = outputTail(done.get(e.commandId)?.stdout, done.get(e.commandId)?.stderr)
      const row: CommandCase = { sessionId: descriptor.id, commandId: e.commandId, command: e.command, segment, output, label: null }
      appendFileSync(file, `${JSON.stringify(row)}\n`)
      count++
    }
  }
  console.log(`Wrote ${count} candidate commands to ${file}.`)
})

const runCommands = async () => {
  const config = jevConfig()
  if (config === undefined) throw new Error("Set REPLAY_JEV=1 and TYPESAFE_API_KEY to run the evaluation.")
  const cases = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as CommandCase)
    .filter((c) => c.label !== null)
  if (cases.length === 0) throw new Error(`No labelled commands in ${file}.`)
  const judged = await mapLimit(cases, 6, async (c) => [c, await judgeCommand(config, c)] as const)
  console.log(`${judged.length} labelled commands · ${judged[0]?.[1].model}\n`)
  console.log("threshold  shown-as-check  agree  wrong-kind  not-a-check-shown-as-check")
  for (const threshold of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const shown = judged.filter(([, j]) => j.kind !== "not_a_check" && j.confidence >= threshold)
    const agree = shown.filter(([c, j]) => c.label === j.kind).length
    const invented = shown.filter(([c]) => c.label === "not_a_check").length
    console.log(`${threshold.toFixed(1).padStart(9)}  ${String(shown.length).padStart(14)}  ${String(agree).padStart(5)}  ${String(shown.length - agree - invented).padStart(10)}  ${String(invented).padStart(26)}`)
  }
  const checks = judged.filter(([c]) => c.label !== "not_a_check").length
  console.log(`\n${checks} labelled as checks; ${judged.length - checks} as not a check.`)
  const misses = judged.filter(([c, j]) => c.label !== j.kind)
  if (misses.length > 0) {
    console.log("\nDisagreements (label vs answer, confidence):")
    for (const [c, j] of misses) console.log(`  ${c.label} vs ${j.kind} ${j.confidence.toFixed(2)}  ${c.segment.slice(0, 80)}`)
  }
}

interface NarrationCase {
  readonly sessionId: string
  readonly eventId: string
  readonly text: string
  readonly label: boolean | null
}

const collectNarration = Effect.gen(function*() {
  const bridge = yield* Bridge
  const sessions = [...yield* Stream.runCollect(bridge.sessions.list())]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "")
  let count = 0
  for (const descriptor of sessions) {
    const events = yield* Stream.runCollect(bridge.sessions.events(descriptor.id, { redact: true })).pipe(
      Effect.orElseSucceed(() => [])
    )
    for (const m of narrationMessages([...events])) {
      appendFileSync(file, `${JSON.stringify({ sessionId: descriptor.id, eventId: m.eventId, text: m.text, label: null })}\n`)
      count++
    }
  }
  console.log(`Wrote ${count} mid-turn messages to ${file}.`)
})

const runNarration = async () => {
  const config = jevConfig()
  if (config === undefined) throw new Error("Set REPLAY_JEV=1 and TYPESAFE_API_KEY to run the evaluation.")
  const cases = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as NarrationCase)
    .filter((c) => c.label !== null)
  const judged = await mapLimit(cases, 6, async (c) => [c, await judgeNarration(config, c.text)] as const)
  const positives = cases.filter((c) => c.label).length
  console.log(`${judged.length} labelled messages (${positives} announce a new step)\n`)
  console.log("threshold  said-yes  agree  false-yes  false-no")
  for (const threshold of [0.5, 0.7, 0.8, 0.9]) {
    let yes = 0, agree = 0, fy = 0, fn = 0
    for (const [c, p] of judged) {
      const predicted = p >= threshold
      if (predicted) yes++
      if (predicted === c.label) agree++
      else if (predicted) fy++
      else fn++
    }
    console.log(`${threshold.toFixed(1).padStart(9)}  ${String(yes).padStart(8)}  ${String(agree).padStart(5)}  ${String(fy).padStart(9)}  ${String(fn).padStart(8)}`)
  }
  for (const [c, p] of judged) if ((p >= 0.7) !== c.label) console.log(`  label ${c.label} p=${p.toFixed(2)}  ${c.text.replace(/\s+/g, " ").slice(0, 110)}`)
}

if (mode === "collect-narration") {
  await Effect.runPromise(collectNarration.pipe(Effect.provide(NodeBridge.layer({ probeVersions: false }))))
} else if (mode === "run-narration") {
  await runNarration()
} else if (mode === "collect-commands") {
  await Effect.runPromise(collectCommands.pipe(Effect.provide(NodeBridge.layer({ probeVersions: false }))))
} else if (mode === "run-commands") {
  await runCommands()
} else if (mode === "collect-replies") {
  await Effect.runPromise(collectReplies.pipe(Effect.provide(NodeBridge.layer({ probeVersions: false }))))
} else if (mode === "run-replies") {
  await runReplies()
} else if (mode === "collect") {
  await Effect.runPromise(collect.pipe(Effect.provide(NodeBridge.layer({ probeVersions: false }))))
} else if (mode === "run") {
  await run()
} else {
  console.error(
    "Usage: eval-jev.ts collect | run | collect-replies | run-replies | collect-commands | run-commands [file] [--limit N]"
  )
  process.exitCode = 1
}
