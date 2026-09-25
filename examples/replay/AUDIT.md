# Replay goal-based audit

Date: 2026-09-24. Scope: current working tree, including the uncommitted Replay app.

## Verdict

**Strong structural MVP; not yet a reliably trustworthy reconstruction.** The editorial shell, deterministic story, stable geography, and evidence views match the product thesis. The highest-value next work is factual correctness and synchronized investigation, not AI narration or more animation.

The north star is GOAL §50: understand an unfamiliar 45-minute session in minutes. A false “Fixed failing tests” is more damaging to that goal than a sparse map or plain prose.

No application source was modified during this audit. This report and ignored audit artifacts were added.

## Evidence and limits

- Read GOAL.md, README.md, derivation, playback, routes, all views/inspectors, map, review store, API, and existing tests.
- `pnpm exec vitest run examples/replay/test`: **60 tests passed**.
- `pnpm typecheck`: **passed** (root and Replay).
- `pnpm --filter @agentbridge/example-replay build`: **passed**, 377.12 KB client JS / 118.66 KB gzip.
- Ran fixture Vite server on `127.0.0.1:5183`; inspected picker (14 sessions), Claude fixture overview, scene deep link, terminal shortcut, Events → Story, keyboard interaction, and 390×844 layout. No console errors in those sampled flows.
- Reproduced derivation failures using **schema-decoded canonical events**, not provider-shaped mock objects. Run `node .gstack/replay-audit/repro.mjs`; output is also in `.gstack/replay-audit/repro-results.txt`.
- Screenshots: `.gstack/replay-audit/overview-loaded.png`, `event-to-story.png`, `keyboard.png`, `mobile-scene.png`. The earlier `overview.png` is a blank browser setup capture, not app evidence.
- Browser fixture testing was sampled, not exhaustive. Real local histories, screen-reader behavior, and 10k-event browser performance were not independently reverified. README's earlier real-history verification is not treated as fresh audit evidence.

## Prioritized findings

### 1. P1 — “Fixed failing tests” can be unsupported by the evidence

**Reproduced:** `pnpm test` fails → change `a.ts` → `pnpm lint` succeeds. Chapter title becomes **“Fixed failing tests.”** Tests were never rerun.

`src/story/deterministic.ts:327` groups any subsequent validation after an edit into a debugging sequence; `chapterTitle` at line 420 uses the first validation's kind and the last validation's outcome. Neither check establishes that the failed validation was retried.

**Improve:** retain validation identity/scope and separate successful checks from unresolved failures. Use “Edited after failing tests; lint passed” when correction is not demonstrated. Even two different test scopes should not automatically imply a fix.

**Acceptance:** failed tests → passing lint, failed auth tests → passing unrelated tests, and interrupted retries never produce a “fixed” claim. Matching rerun success remains evidence-linked. Covers GOAL §§19–21, 44, 48.

### 2. P1 — Canonical command results can be present but described as unrecorded

**Reproduced:** `command.started` plus `command.completed` sharing `commandId`, with no `parentEventId`, produces “Ran tests → outcome unknown” and “The outcome ... was not recorded,” despite `outcome: succeeded`.

`buildSteps` (`src/story/deterministic.ts:55`) joins tool results by `toolCallId`, but does not join command results by `commandId`. Classification happens before these separate steps are gathered into a scene. Bridge's schema permits this event shape.

**Improve:** preindex command starts/completions by canonical ID; resolve the outcome of the specific command, not the first completion in a root step. Cover multiple commands attached to one tool and interleaved completions.

**Acceptance:** linked and unparented forms derive the same outcome and terminal evidence. Covers GOAL §§3, 19, 24, 44.

### 3. P1 — Command heuristics manufacture validation activity

**Reproduced:** `classifyCommand('rm -rf build')` returns build validation; `classifyCommand('touch test')` returns test validation. These strings were classified only, never executed.

`src/story/commands.ts:19` matches validation words across all command tokens, including operands. A successful file-management command can therefore make the overview claim validation passed. `pnpm test || true` also requires caution: the shell's success does not establish test success.

**Improve:** recognize executables and their validation subcommands conservatively; otherwise label the literal command without claiming a check. Distinguish aggregate shell outcome from constituent check outcome.

**Acceptance:** validation-named files/directories and error-masking shell chains cannot create false passing-check claims. Covers GOAL §§19, 20, 44.

### 4. P1 — Diff parsing silently removes real changed lines

**Reproduced:** `diffStat('@@ -1 +1 @@\n---removed text\n+++added text\n')` returns `{ additions: 0, deletions: 0 }`, rather than 1/1. These are valid hunk lines whose file contents start with `--` and `++`.

`src/replay/files.ts:44–45` excludes all `+++`/`---` prefixes. `src/components/DiffViewer.tsx:12` similarly discards them regardless of whether parsing is inside a hunk. The reader loses actual code evidence, not just a cosmetic count.

**Improve:** share a hunk-aware parser between counts and rendering; distinguish file headers from hunk contents. Also make full-content versus unified-diff handling explicit rather than relying only on `includes('@@')`.

**Acceptance:** header-like changed content renders and counts correctly. Add tests for empty changes, metadata-only diffs, multiline content, and no-newline markers. Covers GOAL §§22–23, 44.

### 5. P2 — Cross-view investigation does not fully synchronize

**Browser reproduced:** open fixture → Events → `file.changed` → “Show in story.” Cursor seeks correctly and map emphasis changes, but detail remains **Evidence**, with **no selected file**, rather than opening that change's diff and selecting the file as GOAL §16 specifies.

`src/views/EventsView.tsx` dispatches seek + Story only. `src/playback/reducer.ts` does not derive file/detail selection when seeking an event. `StoryView.SceneDiff` also prioritizes current/scene changes over a separately selected file, which can leave selection and displayed diff describing different files.

**Improve:** introduce a shared event-navigation action that resolves scene, file, and appropriate inspector atomically. Preserve the intentional distinction between map selection (does not seek) and explicit event navigation (does seek). Make the selected-file versus current-event diff policy visible.

**Acceptance:** navigating from Events, Changes, or Evidence to the same event yields the same cursor, selected file, and inspector. Map selection alone preserves playback position. Screenshot: `event-to-story.png`.

### 6. P2 — Keyboard access misses the core content and hijacks native activation

**Browser reproduced:** focus the Changes tab and press Space. Playback starts while Story remains selected; the focused tab is not activated. `src/playback/shortcuts.ts` intercepts Space on buttons because only inputs, textareas, selects, and editable content are excluded.

**Source confirmed:** chapter/scene headings, story beats, event rows, terminal cards, file-scene links, and SVG map files are clickable `div`/`li`/`g` elements without keyboard activation. Timeline has `role="slider"` but `tabIndex={-1}`. Tab navigation moves through review checkboxes, not the story selection controls.

**Improve:** use native interactive elements, implement appropriate tab/slider keyboard behavior, and leave Space activation to focused controls. Supply a keyboard-accessible file list as an alternative to map geometry.

**Acceptance:** complete session → chapter → file → evidence → review using only keyboard; activating a focused button never toggles unrelated playback. Screenshot: `keyboard.png`.

### 7. P2 — Incremental canonical tool metadata is ignored

**Reproduced:** `tool.started(kind: other, name: pending)` → `tool.updated(kind: edit, name: edit file, input: …)` → `tool.failed` derives **“Conversation”**, not an attempted edit.

`buildSteps` attaches `tool.updated`, but `classify` still reads the original root's kind. `src/components/ToolInspector.tsx` likewise displays `tool.name`, `tool.kind`, and `tool.input` from the start event. This loses canonical information already supplied by Bridge.

**Improve:** fold updates into a derived tool projection, without mutating raw events. Respect omitted fields and explicit input null. In playback, clearly distinguish as-of-cursor state from full-session outcome.

**Acceptance:** late metadata and equivalent complete-start metadata produce equivalent final summaries/inspectors, while Events retains original facts. Covers GOAL §§3, 15, 25.

### 8. P2 — Overview command counts and failure counts use different definitions

**Reproduced:** failed `cat missing.txt` yields `commands: 0`, `failedCommands: 1`, and summary **“No files or commands were recorded.”** The command was recorded; it was merely classified as exploration.

`src/replay/derive.ts:buildStats` excludes read-only starts from command count but counts all failed completions. The overview can show “0 commands / 1 failed.” This obstructs GOAL §44's “What commands ran?” and hides failed exploration.

**Improve:** count all commands, optionally split into inspection/work/validation. Base “not recorded” on evidence absence, not presentation filtering. Link summary counts to their supporting events.

**Acceptance:** command totals and failures use the same population; failed inspections remain discoverable without raw-transcript reading.

## Product improvements after correctness

### A. Make the overview a briefing, not just activity totals

The fixture overview is readable and visually restrained, but `buildSummary` mostly counts prompts, chapters, files, and commands. It does not expose a final-result section, unresolved failures, scope of validation, or links from summary claims to their exact evidence. The first prompt is repeated in the overview and chapter, while active narration again shows its full text.

**Next slice:** “Asked / Work performed / Checks and unresolved issues / Agent-reported result” with evidence links and explicit attribution. Keep reported completion separate from verified outcomes; do not require an LLM. This targets the north star more directly than richer prose or graphics.

### B. Keep the map and evidence available while reading

Desktop has a stable side stage, which is the right foundation. On narrower layouts, CSS stacks the **entire narrative** before the stage. On mobile the map hides until fullscreen, but active-file context is not placed alongside each active scene. The stage can be far below the current passage. Ordinary scrolling also does not update the cursor; synchronization is cursor → scroll only.

**Next slice:** active-scene file chips and a nearby evidence affordance; sticky compact stage on tablet; visible route into mobile full map. Decide explicitly whether scrolling selects a scene or remains independent reading, and show that distinction. Do not silently conflate scroll position and playback.

The desktop map also omits directory labels for singleton regions. A two-file map shows only `README.md` and `usage.md`, not the latter's `docs/` geography until inspection. Show full paths on focus and provide region labels where spatially useful.

### C. Make sessions findable and review completion durable

`SessionPicker` silently caps filtered results at 400 with no pagination or “showing N of M.” Rows show project, harness, date, size and ID, not the task. For many sessions in the same repo, reviewers must open candidates to learn what they concern.

**Next slice:** pagination/load-more, count disclosure, optional cached title/task preview through public Bridge data, project grouping, and read-only refresh/retry. Avoid eagerly reconstructing every session just to populate the list.

`ReviewStore` catches JSON syntax errors, but parsed `null` or malformed non-iterable fields can still crash loading. Review identifiers (`ch1`, `sc1`) are positional and have no derivation/snapshot version. Future derivation changes or growing sessions can attach prior review marks to different content. Validate stored shape and tie review state to stable evidence/version identity.

### D. Prove large-session comprehension and performance

Events virtualization is a good start, but `EventsView` creates `rel = normalizePath(...)` on every render and includes it in `useMemo` dependencies. Every scroll render rebuilds/describes the entire event list. ToolInspector scans all events; Changes groups by repeatedly filtering all changes for each chapter and copies each per-file array on insertion. Loading collects/decodes/derives the complete session on the browser thread. Story renders every chapter and scene.

These are **source-established scaling risks, not measured latency claims**. Add a 10k-event / hundreds-of-files fixture and browser timing before choosing optimizations. Memoize stable projections, index tool/command relationships, accumulate change groups once, then consider worker-based derivation and map aggregation based on measurements.

Diff rendering stops at 1,500 lines and only says more lines are not shown. Add expand/download/full-evidence access; a hard truncation must not masquerade as a complete review surface.

### E. Make investigation state shareable

Scene deep links worked in the sampled browser check. However, Story formatting drops file selection when a scene is present, and Changes keeps chapter group selection only in component state. Switching views/reloading can lose which occurrence of a repeatedly changed file was under review. `decodeURIComponent` also throws for malformed route escapes without a fallback.

**Next slice:** round-trip scene + file + selected change/group where needed, graceful invalid routes, and deliberate browser history behavior. Playback can replace history while explicit user investigation actions remain navigable.

## Goal coverage assessment

| Goal area | Current evidence | Assessment |
|---|---|---|
| Public canonical API, shared provider-independent pipeline | Source + architectural tests + fixture equivalence | Strong foundation |
| Deterministic offline story, no AI | Pure derivation and 60 passing tests | Present, semantic counterexamples above |
| Stable session-wide geography | Single derivation layout; determinism tests | Present; large-map usability unverified |
| Scenes/chapters linked to evidence | Invariant tests and fixture UI | Present; valid IDs alone do not prove truthful labels |
| Overview and unfamiliar-session understanding | Fixture overview + summary implementation | Partial; outcomes and unresolved work need emphasis |
| Play/pause, event/scene navigation, deep links | Reducer/source and sampled browser checks | Present; keyboard and synchronization gaps |
| Changes/diff, terminal, tools, raw events | Source, derivation reproductions, sampled UI | Present; evidence fidelity gaps |
| Review state outside Bridge | localStorage implementation | Present; validation/versioning gaps |
| Responsive and reduced motion | CSS + mobile screenshot | Implemented basics; mobile evidence proximity weak |
| 10k+ events / hundreds of files | Virtualized Events/source analysis | Not independently performance-verified |
| Real Claude and Codex sessions | README reports earlier checks; fixture equivalence freshly passes | Fresh real-history/user-comprehension test still needed |

## Recommended order and verification

1. **Trust:** fix findings 1–4, 7–8 with canonical regression cases. Require every “passed/fixed/not recorded” statement to agree with its evidence.
2. **Investigation:** fix findings 5–6, route round-tripping, and malformed stored state. Add browser tests for deep links, evidence → diff/map, focused-button Space, review reload, and unknown outcomes.
3. **Understanding:** build the briefing and mobile active-file/evidence treatment; improve picker discovery and full diff access.
4. **Scale and acceptance:** measure 10k-event interaction/render/load budgets and run a comprehension exercise on an unfamiliar real 45-minute session. Ask a reviewer to identify goal, path, changed files, failed/retried checks, unresolved work and final result; verify each answer against canonical events. Record time and evidence-navigation effort.

Do not spend the next iteration on AI narration, repository-wide indexing, symbol graphs, terminal typing, or file-evolution playback. Those are optional, later, or explicitly outside MVP; they do not repair the trust and comprehension gaps identified here.
