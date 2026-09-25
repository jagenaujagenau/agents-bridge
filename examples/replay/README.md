# Replay

Replay turns a coding-agent session into something you can follow as a story. It is a reference
application for Bridge, and a test of its public API: it builds everything from `Session` and
`SessionEvent` alone, never by looking at which harness produced a session. See [GOAL.md](GOAL.md)
for the product spec.

```bash
pnpm replay                                            # from the repo root: http://localhost:5173
pnpm --filter @agentbridge/example-replay dev:fixtures # the checked-in fixtures instead of local history
```

The session list shows, for each session, its title (its own, else the first line of its first prompt), the model that did most of the work, with its vendor's
mark and the rest in the tooltip, and the tokens it spent: input, cached input and output summed
over every model call, broken down on hover. Both come from the canonical `usage.recorded` events,
so the dev server reads each session once (`/api/summaries`, redacted) and caches the result in
`~/.bridge/replay-summaries.json`, keyed by the session file's state. A page of 200 fills in in about 2
seconds the first time and under half a second after. Sessions whose harness records no usage show
"—". Vendors come from the model name (`src/models/vendors.ts`), never from the harness; OpenAI,
xAI and Z.ai have no logo in `simple-icons` and get a letter badge.

Pick a session, then read the overview, press <kbd>Space</kbd> to play, or jump by chapter. Links
are deep: `#/session/<id>/scene/sc4`, `/story/ch2`, `/event/<eventId>`, `/file?path=…`, `/changes`,
`/events`.

| Keys | |
|---|---|
| <kbd>Space</kbd> | play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | previous / next event |
| <kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> | previous / next scene |
| <kbd>K</kbd> <kbd>J</kbd> | previous / next chapter |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>4</kbd> <kbd>8</kbd> | speed |
| <kbd>E</kbd> <kbd>D</kbd> <kbd>T</kbd> | evidence, diff, terminal |
| <kbd>F</kbd> | select the file under the cursor |
| <kbd>R</kbd> | mark the current scene reviewed (the selected file in Changes) |
| <kbd>Esc</kbd> | clear selection, back to Story, pause |

## Fleet

`#/fleet` (linked from the session list) shows every session Bridge lists as one picture over
time: sessions appear when they start and glow while they work, subagents hang off the session
that spawned them, and top-level sessions gather around their project. The left panel has the date
at the playhead, counts, and the session types (subagent label, else harness), each clickable to
isolate. The right panel has the spawn log and, for a selected session, its tree and a link into
its replay. Below is a strip of activity over time: click to move the playhead, Space to play, ×1
to ×20 days per second, ← → a day at a time. `#/fleet?project=…` narrows to one project and keeps
whole spawn trees.

**A session's own fleet** (`#/fleet?session=…`, the "Fleet" link in a session's top bar, or "Its
fleet" on a selected session) shows that session's family: the root session, every subagent
below it, and each agent's scenes as steps orbiting it. Opening it from a subagent shows the whole
family from the root. Agents are neutral, named hubs; color is left to the steps (read, change,
check, command, conversation), and a failed check is ringed in the reserved critical color and
named in the legend and step log. Each agent in the family is read and derived, so this scope
takes a moment where the full fleet does not. Times come from recorded events, not from a file's
modification time, and playback always covers the whole span in two minutes at ×1, whether it is
an hour or half a year.

It is built from the session listing only (`src/fleet/model.ts`), so it opens at once. The only
per-session reads are titles for the entries on screen in the spawn log, fetched lazily and
redacted. The layout is a force layout run to rest once with a fixed random source
(`src/fleet/layout.ts`), so the same sessions land in the same place. Sessions often last minutes
while playback moves days per second, so a session's light fades over half a day after its last
activity; "Working now" counts only sessions strictly within their recorded span. Type colors come
from the validated categorical palette, assigned by type across all sessions so filtering never
repaints one; a ninth type or more is grey.

## How it works

```text
dev server (src/server/api.ts)          browser
  Bridge.sessions.list / get / events  ──JSON──>  decode (schema) ─> buildReplaySession ─> React
  + git enricher, read-only                          steps → scenes → chapters, files, map, timeline
```

- **Derivation is pure and runs offline.** `deriveReplay(session, events)` in `src/replay/derive.ts`
  needs no LLM, no network and no provider knowledge. `buildReplaySession` is the Effect wrapper
  around it that collects a Bridge stream.
- **Steps.** Each root event plus everything attached to it: derived events by `parentEventId`, tool
  results and `tool.updated` by `toolCallId`, command results by `commandId`. A step is classed by
  canonical facts only: file events, the tool `kind` after folding in `tool.updated`, and command
  text.
- **Checks** (`src/story/commands.ts`) are recognized by executable and subcommand or script name
  (`pnpm test`, `cargo clippy`, `nix develop -c gleam test`), never by a word appearing anywhere,
  so `rm -rf build` is not a build. A check's result comes from its own command's completion. If a
  pipe, `||` or `;` decides the shell's exit status (`pnpm test | tail`, `pnpm test || true`), the
  result is reported as unknown.
- **Scenes** break at prompts, at a change of activity (read, change, validate, command), at every
  validation run, after 15 minutes of silence, and after 12 actions. Short reads that lead straight
  into an edit count as part of the edit. Reasoning and agent messages go with the action that
  follows them; the closing reply stays with the work it reports.
- **Chapters** group one prompt's scenes into exploration, implementation, validation or debugging.
  Debugging is a failed check, then changes, then a re-run of *that same check*. A different
  check passing afterwards proves nothing about the one that failed, so it is never titled a fix.
  The overview reports the final state of every distinct check. Adjacent chapters of the same
  kind, short look-arounds and lone commands are merged, so a long session reads as phases rather
  than a log.
- **Labels** state activity, never intent: "Explored src/auth", "Changed session.ts and auth.ts",
  "Ran tests → failed", "Fixed failing tests".
- **The map** packs files into their directory regions (d3-hierarchy) once per session, with size
  set by activity (a read is 1, a change 4). Coordinates never change while the session is open;
  playback only changes emphasis.
- **One cursor.** Playback state is a timeline index (`src/playback/reducer.ts`); the chapter,
  scene, highlighted files, diff and terminal all derive from it. Presentation time comes from each
  event's type, not from wall-clock time.
- **Review state** lives in `localStorage` under `replay:review:<sessionId>` and never touches
  Bridge data.

## Optional: judging hidden check results with Jev

Agents often pipe checks into `tail` or append `|| true`. The shell's exit status then says nothing
about the check, and Replay reports the result as unknown. On the development machine that was 87% of
checks. The output usually does say ("408 passed, 1 failures", "error TS2345"), and reading it is a
judgment, so Replay can ask [Jev](https://docs.typesafe.ai), TypeSafe's System One model.

```bash
# examples/replay/.env.local (git-ignored; read by the dev server and the eval script, never sent to the browser)
REPLAY_JEV=1
TYPESAFE_API_KEY=…
```

- **Off unless both variables are set.** Without them nothing leaves the machine, and the story is
  fully deterministic and works offline, as the GOAL requires.
- **What is sent:** for each such check, the command and the last 80 lines of its output, read again
  on the server with Bridge's redaction applied. The browser cannot choose what is sent. Before
  enabling it, consider what your sessions' output contains.
- **Only when the output is the check's own.** If other commands run after the check
  (`gleam test | tail -1; nix build`), the recorded output belongs to them, and the check is never
  sent.
- **What is asked:** one Choice per check, `passed` / `failed` / `unclear`
  (`src/server/jev.ts`). The criteria spell out the edge cases: a check that could not run failed,
  and cut-off or unrelated output is unclear.
- **How answers are used:** a judgment only ever fills in an *unknown* result, never overrides one
  that was recorded. Below confidence 0.6 (`MIN_JUDGMENT_CONFIDENCE`) the result stays unknown.
  Accepted results read "passed (inferred)" everywhere they appear. The terminal names the model
  and its confidence, and chapters worded from them have `derivation: "ai"`.
- **Flow:** the deterministic story shows at once; judgments arrive afterwards and the story is
  derived again. Results are cached for the life of the dev server.

Measure before trusting the threshold:

```bash
pnpm --filter @agentbridge/example-replay eval:jev collect   # → ~/.bridge/replay-jev-eval.jsonl, label: null
# set "label" to passed / failed / unclear on the lines you check
pnpm --filter @agentbridge/example-replay eval:jev run
```

`run` reports, per threshold, how many results would be shown, how many agree with your labels, and
how many failed checks would be shown as passed, the mistake that matters most. Pin a versioned
model (`REPLAY_JEV_MODEL=jev-1.13.0`) once the threshold is tuned, because `jev-latest` moves.

**Measured on 2026-09-24** with `jev-1.13.0` on every hidden check with recorded output in local
history: 775 checks from Claude Code, OpenCode and pi sessions. The 465 whose output is the check's
own were all labelled by hand; the rest are never sent.

| threshold | results shown | agree with label | failed shown as passed |
|---|---|---|---|
| 0.5 | 414 (89%) | 409 | 0 |
| **0.6** (default) | **409 (88%)** | **405 (99%)** | **0** |
| 0.8 | 348 (75%) | 344 | 0 |
| 0.9 | 279 (60%) | 279 | 0 |

At 0.6, by check kind: typecheck 222/224 of 257, tests 96/98 of 99, build 68/68 of 78, lint
14/14 of 24 (Jev most often answers "unclear" on lint output), checks 5/5 of 7. By harness:
OpenCode 274/276, Claude Code 131/133. Repeated runs over the same inputs differed by one case.

All four remaining misses err toward "failed" where the output does not show a result: typecheck
output showing only `message TS…` lines, a bare `grep -c "error"` count, and two crash reports that
a test produces on purpose. Three rounds of evaluation shaped the
current design:

- **Mixed output is never sent.** Jev called four such checks "passed" at confidence 0.86–0.95,
  which no threshold filters.
- **The criteria say warnings alone are not failures.**
- **Filtered output that doesn't show the whole check is unclear.** `swift test | grep ResumeParity`
  had been "passed" at 0.96; it is now 0.58, below the threshold.

Three of my own labels turned out to be wrong, and Jev was right each time. The labels are one
person's judgments, from one machine's sessions, mostly TypeScript and Gleam projects.

### Two more judgments, and one that did not make it

The same opt-in (`REPLAY_JEV=1`) enables two more kinds of question. Both were measured before
being used, and both have an `eval:jev` mode (`collect-…` / `run-…`).

- **What the agent said, against what was recorded.** Each request's closing reply gets four
  yes/no questions: does it say the work is done, that tests pass, that a build, type check or lint
  passes, and does it report something still failing or blocked. Code then compares claimed passes
  with the checks recorded in that request. A claim that the last run contradicts, or that no run
  supports, is shown with ⚠ on the chapter and counted in the overview. On 80 hand-labelled replies,
  at threshold 0.5 (`CLAIM_THRESHOLD`): "done" 74/80, "tests pass" 79/80, "build/type check/lint
  passes" 79/80, "something failing or blocked" 77/80. Few replies claimed passes (6 and 9), so
  those two rows rest on little evidence. The first wording of the last question ("work still to
  do") read every "Now I'll…" as a problem; it was narrowed to failures and blockers.
- **Commands the rules do not recognise.** Rules come first: this round added `node --test`,
  `python -m unittest`, `bundle exec`, `xcodebuild`, Gradle task paths, tools called by path
  (`./node_modules/.bin/tsc`), `nix build`/`flake check` and `vite`/`next`/`astro build`. Of 9,514
  commands in local history that no rule recognises, code shortlists 502 that could plausibly be
  checks: script files run by an interpreter, `./scripts/…` executables, unrecognised package
  scripts and make targets (`checkCandidate`). Jev picks tests / typecheck / lint / build / checks /
  not a check from the command and its output. On 75 labelled candidates it never called a
  non-check a check (0 of 63), and at 0.6 (`MIN_COMMAND_KIND_CONFIDENCE`) it identified 5 of the 12
  real checks, all correctly. It is conservative on ad hoc probe scripts. Identified checks read
  "(inferred)", and if their result was hidden too, a second round judges it.
- **Not used: scene breaks from narration.** A mid-turn message like "Now let me run the tests"
  could mark a new step. On 61 labelled messages the best threshold agreed 80% of the time, but it
  called 9 of 21 continuations new steps, which would fragment scenes. Scene boundaries stay
  deterministic. `judgeNarration` and `eval:jev run-narration` remain for re-measuring with later
  models.

## Tests

`test/derive.test.ts`:

- Claude Code and Codex fixtures derive the same story and map.
- Every fixture session from all eight harnesses meets the structural invariants: every event
  belongs to exactly one scene, chapters partition scenes, the map covers every file.
- The GOAL §39 example derives exactly as written.
- Missing timestamps and tools degrade gracefully.
- Command classification is covered.

`test/derive.test.ts` also has a regression case for each derivation finding in
[AUDIT.md](AUDIT.md). `test/ui-state.test.ts` covers navigation sync (opening an event from any view
selects its file and inspector) and malformed routes.

`test/replay.test.ts` is the architectural test. Nothing under `src/` may name a harness,
`harness.id`, `source.provider` or a native tool.

## Verified on real history

A 757-step Codex session and a 399-event Claude Code session from the development machine load
through the same pipeline with no provider branches. Findings that fed back into the derivation:

- Codex reads files through shell commands (`cat`, `rg`), so read-only commands count as
  exploration, not as work the agent ran. Claude Code and Codex fixtures now summarize identically.
- Heredoc bodies (`python3 - <<'EOF'`) and redirects (`echo … >> file`) have to be excluded from
  command classification.
- A failed edit tool call has no file events, so its scene reads "Tried to edit files (failed)".
- Claude Code usually pipes checks into `tail`, so on real history many checks honestly read
  "result unclear" instead of the "passed" an exit code would suggest.

No Bridge change was needed: every primitive Replay uses is canonical.

**Dead time is trimmed.** Stretches where nothing was working, longer than 2% of the span,
collapse on the strip to a dashed break marked "⋯" (hover for "14d 12h quiet, trimmed"), and
playback skips through them. Each break keeps 1.5% of the trimmed strip, however long it was. Dates
shown stay real. "Busy" follows evidence: in a session's own fleet, each step's recorded event
times; in the full fleet, where only the listing is read, a session shorter than a day counts as
busy throughout, and a longer one, usually resumed days later, only around its start and end. On
local history this trims 42% of the 190-day span into six breaks, and eight gaps of 11–61 minutes
inside the 15-agent session. A 1% threshold was tried: 17 breaks, but hardly fewer empty stretches,
since what remains is sparse activity rather than dead time.

**Performance.** The fleet was measured on the production build against local history (630 sessions,
and one 15-agent session), before and after:

| | before | after |
|---|---|---|
| all sessions: map on screen | 1.3–2.4 s, one 1.2 s blocking task | 0.3 s first time, 55 ms after (cached) |
| 15-agent session: map on screen | 1.4–1.6 s, three ~0.5 s blocking tasks | 0.3 s first time, 70 ms after |
| playback | 43–72 fps | 82–87 fps, the same as an idle page |

- **The layout starts close to its answer.** Hubs are seeded on a spiral and everything else in a
  ring around what it links to, so the simulation settles in 120 steps instead of 400
  (613 ms → ~210 ms in node).
- **It runs in a Web Worker and is cached** (`src/fleet/useLayout.ts`): it is deterministic, so
  a fleet with the same nodes and links reuses its positions from memory or `localStorage`.
  Nothing blocks the page while it computes.
- **A session's family is derived on the server** (`/api/family`): the browser receives a few
  kilobytes of scenes instead of decoding and deriving every agent's events.
- **Playback does not re-render what did not change:** the strip's bars are drawn once and a
  single dimmer moves with the playhead; the log is rebuilt only when something new starts; glows
  are stamped from one sprite per color instead of a new gradient per node per frame.

## Audit follow-ups (AUDIT.md, sections A–E)

- **A. The overview is a briefing:** what was asked, the most-changed files, every distinct check
  at its last run (failures first, each linked to that run), and what the closing reply claimed.
  The first prompt is no longer repeated in the first chapter.
- **B. Evidence stays close:** the active scene lists its files as chips that select them on the
  map; on stacked layouts a link jumps to the map and evidence; a focused map node shows its full
  path.
- **C. Finding sessions and keeping review:** the session list says how many it shows and loads
  more on request, and retries a failed listing. Review marks are keyed by the event that opens a
  scene or chapter, so a changed derivation or a growing session cannot move a mark onto other
  content. Task titles in the list are not shown: they need a full read of every session.
- **D. Large sessions:** 10,000 events derive in about 40 ms (a test guards against quadratic work);
  the largest local sessions read and derive in 70–120 ms. Render-time scans were removed from the
  Events, Changes and tool views, and long diffs can be shown in full.
- **E. Shareable state:** a scene link keeps the selected file; deliberate navigation adds a history
  entry that Back undoes, while playback only updates the address.

## Not built yet

- AI narration (GOAL §21). The model already has a slot for it (`derivation: "ai"`).
- Watching a file evolve by scrubbing through its diffs (GOAL §23).
- Collapsing inactive regions in very large maps.
