# Replay — Session Story & Code Map

## Status
Draft v0.1

## Location
`examples/replay/`

Replay initially lives inside the Bridge repository as a reference application and architectural test of Bridge's public API.

## 1. Summary

Replay turns a coding-agent session into an explorable reconstruction of what happened. It is not primarily a transcript viewer.

It should answer: What was the agent trying to accomplish? What happened and in what order? Which parts of the codebase did it touch? What changed? Where did it fail or retry? What evidence supports the narrative?

The primary experience is:

**Story + Persistent Code Map + Timeline + Evidence**

Bridge supplies factual canonical events. Replay derives a presentation model from them.

```text
Bridge Session
      │
      ▼
SessionEvent stream
      │
      ▼
Replay Derivation
      ├── chapters
      ├── scenes
      ├── code geography
      ├── event references
      ├── file activity
      └── playback timeline
             │
             ▼
          Replay UI
```

> Replay should make agent work understandable without hiding the evidence.

## 2. Product Thesis

A chronological agent log is technically complete but cognitively poor. Humans understand work as phases: exploration, implementation, validation, failure, correction, completion.

Replay reconstructs that shape while keeping every statement linked to underlying Bridge evidence.

## 3. Relationship to Bridge

Hard rule: `examples/replay` consumes only Bridge public APIs and canonical Bridge data.

Replay must not import Claude Code, Codex, OpenCode, or other provider parsers, schemas, paths, or event types.

Forbidden:

```ts
if (session.harness.id === "claude-code") {
  // provider-specific Replay behavior
}
```

If generally useful functionality requires provider-specific branching, first determine whether Bridge lacks a canonical primitive.

## 4. Visual Direction

The attached references define the direction: an editorial technical walkthrough, spatial code atlas, debugger for agent work, and interactive narrated code review.

It should not feel like an observability dashboard, chat app, terminal multiplexer, generic graph visualizer, or table-heavy admin UI.

Use generous negative space, restrained chrome, strong typography, progressive disclosure, and a dark editorial canvas. Content is the interface.

## 5. Core Mental Model

```text
Session
  └── Chapter
       └── Scene
            └── Evidence
```

**Session:** complete Bridge session.

**Chapter:** meaningful phase of work, e.g. "Explored authentication", "Implemented persistent sessions", "Fixed failing tests".

**Scene:** smaller step within a chapter, e.g. "Read SessionStore.ts", "Ran authentication tests".

**Evidence:** canonical Bridge events supporting a scene: file reads/changes, commands, tools, messages, etc.

Narrative must always be traceable to evidence.

## 6. Primary Experience

Opening a session starts with an overview containing the title, concise summary, full session code map, and chapter previews. Scrolling or starting playback enters the walkthrough.

The map should occupy substantial visual space. The story explains. The map grounds. Evidence proves.

## 7. Views

### Story
Default narrated walkthrough synchronized with map and evidence. Answers: "What happened?"

### Changes
File/diff representation grouped by chapter, region, file, or chronology. Answers: "What exactly changed?"

### Events
Raw canonical Bridge events. Answers: "What is the underlying evidence?"

The map is a core part of Story rather than requiring another permanent top-level tab in the MVP. A focused fullscreen map mode may be provided.

## 8. Persistent Code Map

The code map is a defining feature. Its layout must remain spatially stable while the story progresses.

Do not recompute layout per chapter. Build the geography once from the complete session, cache coordinates, then change emphasis as playback moves.

```text
GLOBAL MAP

A B C
 D E

Scene 1 → A/B highlighted
Scene 2 → C/E highlighted
Scene 3 → D highlighted
```

This lets users build spatial memory of the session.

## 9. Map Hierarchy

MVP hierarchy:

```text
Repository
  └── Region (directory/package)
       └── File
```

Later, symbols or hunks can be added. Start with directory/package grouping rather than semantic architecture inference.

## 10. Map Node Encoding

Keep encoding restrained:

- size → amount of session activity
- emphasis → active in current scene
- ring → selected
- muted → unrelated to current scene
- marker → changed
- pulse → currently playing event

Activity is not "importance". Name it accurately.

Initial activity heuristic:

```text
file read       +1
file changed    +4
patch applied   +4
tool reference  +1
```

## 11. Stable Layout

Conceptual input:

```ts
interface CodeMapInput {
  readonly files: ReadonlyArray<ReplayFile>
  readonly relationships: ReadonlyArray<FileRelationship>
}
```

MVP algorithm:

1. Group files by directory/package.
2. Compute activity weight.
3. Size region from aggregate activity/file count.
4. Pack regions.
5. Pack file nodes inside regions.
6. Cache coordinates.

```ts
interface MapPosition {
  readonly x: number
  readonly y: number
  readonly radius: number
}
```

Coordinates are immutable for the lifetime of the loaded Replay session. Deterministically sort inputs and seed any randomized layout.

## 12. Relationships

Initial useful relationships:

- same directory
- changed in same scene
- referenced by same command
- changed consecutively

Later: imports, symbol references, git co-change history, test↔source relationships.

Do not permanently render every edge. Reveal relationships on hover/selection to avoid graph noise.

## 13. Playback Model

```ts
interface PlaybackState {
  readonly status: "paused" | "playing" | "ended"
  readonly cursor: ReplayCursor
  readonly speed: 0.5 | 1 | 2 | 4 | 8
}
```

Users can jump by chapter, scene, event, or file.

## 14. Source Time vs Presentation Time

Do not assume real event duration equals useful viewing duration. A command may take 40 seconds while an important edit occurs instantly.

Maintain:

- **source time:** actual session chronology
- **presentation time:** how Replay paces content for comprehension

MVP may navigate primarily by scene/event progression instead of simulating literal real time.

## 15. Replay Cursor

```ts
interface ReplayCursor {
  readonly chapterId: ChapterId
  readonly sceneId: SceneId
  readonly eventIndex: number
  readonly sourceTimestamp?: string
}
```

Everything derives from this one cursor: active chapter, scene, highlighted files, diff, terminal, tools, and timeline position.

## 16. Synchronization

Selecting something anywhere synchronizes the rest.

Example:

```text
click FileChanged event
  ├── seek timeline
  ├── select file
  ├── highlight map node
  ├── open relevant diff
  └── show containing scene
```

Clicking a map file shows its activity and scenes without unexpectedly destroying playback position.

## 17. Derived Replay Model

Bridge data stays immutable.

```ts
interface ReplaySession {
  readonly session: Session
  readonly chapters: ReadonlyArray<ReplayChapter>
  readonly scenes: ReadonlyArray<ReplayScene>
  readonly files: ReadonlyMap<string, ReplayFile>
  readonly map: ReplayMap
  readonly timeline: ReplayTimeline
  readonly eventIndex: ReplayEventIndex
}
```

### ReplayChapter

```ts
interface ReplayChapter {
  readonly id: ChapterId
  readonly index: number
  readonly title: string
  readonly summary?: string
  readonly sceneIds: ReadonlyArray<SceneId>
  readonly eventIds: ReadonlyArray<EventId>
  readonly filePaths: ReadonlyArray<string>
  readonly startSequence: number
  readonly endSequence: number
  readonly kind:
    | "exploration"
    | "implementation"
    | "validation"
    | "debugging"
    | "other"
  readonly derivation: "deterministic" | "ai" | "user"
}
```

### ReplayScene

```ts
interface ReplayScene {
  readonly id: SceneId
  readonly chapterId: ChapterId
  readonly index: number
  readonly title: string
  readonly description?: string
  readonly eventIds: ReadonlyArray<EventId>
  readonly filePaths: ReadonlyArray<string>
  readonly commandIds: ReadonlyArray<CommandId>
  readonly toolCallIds: ReadonlyArray<ToolCallId>
  readonly startSequence: number
  readonly endSequence: number
}
```

### ReplayFile

```ts
interface ReplayFile {
  readonly path: string
  readonly region: string
  readonly language?: string
  readonly activity: number
  readonly readCount: number
  readonly changeCount: number
  readonly sceneIds: ReadonlyArray<SceneId>
  readonly eventIds: ReadonlyArray<EventId>
  readonly additions?: number
  readonly deletions?: number
}
```

## 18. Event Index

Precompute indexes rather than repeatedly scanning sessions in React components.

```ts
interface ReplayEventIndex {
  readonly eventById: ReadonlyMap<EventId, SessionEvent>
  readonly sceneByEvent: ReadonlyMap<EventId, SceneId>
  readonly scenesByFile: ReadonlyMap<string, ReadonlyArray<SceneId>>
  readonly eventsByFile: ReadonlyMap<string, ReadonlyArray<EventId>>
}
```

## 19. Deterministic Story Derivation

Replay must work without an LLM.

Use evidence such as file locality, time gaps, tool transitions, command boundaries, test runs, change bursts, agent messages, git activity, and lifecycle transitions.

Pipeline:

```text
events
  ↓
candidate scenes
  ↓
merge tiny scenes / split oversized scenes
  ↓
label scenes
  ↓
group adjacent scenes
  ↓
chapters
```

### Scene boundaries

Potential boundaries:

- large time gap
- major region transition
- command/test run after edit burst
- explicit agent transition message
- tool activity category change
- lifecycle transition

### Deterministic labels

Examples:

```text
read-heavy + auth/
→ "Explored authentication"

changes concentrated in SessionStore.ts
→ "Changed SessionStore.ts"

command = pnpm test
→ "Ran the test suite"

failed validation followed by edits
→ "Fixed failing tests"
```

A boring factual label is preferable to fabricated intent.

## 20. Chapter Categories

Initial heuristics:

**Exploration:** mostly reads/searches/messages, few changes.

**Implementation:** mostly file changes, patches, write tools.

**Validation:** tests, builds, lint, typecheck.

**Debugging:** validation failure → exploration/edit → validation retry.

These are Replay presentation metadata, never Bridge truth.

## 21. Optional AI Narration

AI enhances deterministic structure rather than creating the structure from nothing.

```text
Bridge events
     ↓
deterministic scenes
     ↓
deterministic chapters
     ↓
compact evidence bundle
     ↓
optional narration
```

AI may improve chapter titles, summaries, scene descriptions, and the session summary.

Narration output must reference valid evidence IDs and must not introduce unsupported files, commands, outcomes, or intent.

```ts
interface NarratedChapter {
  readonly title: string
  readonly summary: string
  readonly evidence: ReadonlyArray<EventId>
}
```

Replay rejects references to nonexistent evidence.

No-AI mode is a first-class supported mode. AI improves prose, not correctness.

## 22. Evidence Panel

Every scene exposes supporting evidence:

```text
Built persistent sessions

SessionStore.ts             +82
auth.ts                     +24 -13
api.ts                      +16

Commands
pnpm test auth              ✓

Tools
Read × 8
Edit × 4
Bash × 2

[Inspect evidence]
```

Selecting evidence opens the relevant specialized view.

## 23. Changes & Diff

Changes can group by chapter, region, file, or chronology. Default to chapter.

Diff supports unified and split modes where practical, and should eventually show which scene introduced a hunk, which events produced it, and whether later events modified it.

Future: scrub playback and watch a file evolve. Not MVP.

## 24. Terminal

Reconstruct commands from canonical command events:

- command
- cwd
- start/duration
- exit code
- stdout
- stderr

Playback semantics:

```text
before → pending
during → running
after  → completed
```

Do not fake terminal typing unless evidence supports it.

## 25. Tool Inspector

Show generic canonical tool data:

```text
Tool
Input
Output
Duration
Status
Parent event
Derived semantic events
```

This is also useful for debugging Bridge normalization.

## 26. Event Inspector

Show canonical JSON and optionally its source reference. Provider raw payloads are secondary and not shown by default.

## 27. Review State

Allow users to mark chapters, scenes, and files reviewed.

```ts
interface ReviewState {
  readonly reviewedChapters: ReadonlySet<ChapterId>
  readonly reviewedScenes: ReadonlySet<SceneId>
  readonly reviewedFiles: ReadonlySet<string>
}
```

Review state belongs to Replay, not canonical Bridge data.

Use restrained progress such as `12 / 18 changed files reviewed`. Avoid gamification.

For the example app, localStorage is sufficient.

## 28. Session Overview

Before playback show:

- session title and summary
- harness
- duration
- event count
- files read/changed
- commands
- tests/builds
- compatibility warnings
- full code map
- chapter previews

The overview should answer "Is this session worth reviewing deeply?" within seconds.

## 29. Navigation

Top level:

```text
Replay
  Story
  Changes
  Events
```

Suggested keyboard controls:

```text
Space       play / pause
← / →       previous / next event
Shift+←/→   previous / next scene
J / K       previous / next chapter
1           1x
2           2x
4           4x
8           8x
F           focus selected file
D           diff
T           terminal
E           evidence
R           mark reviewed
Esc         close detail / return
```

Do not hijack standard browser shortcuts.

## 30. Deep Links

Prefer URL-addressable state:

```text
/session/:id
/session/:id/story/:chapter
/session/:id/scene/:scene
/session/:id/file?path=...
/session/:id/event/:event
```

## 31. Technology

Recommended:

```text
React
Effect V4
Bridge public API
Vite
D3 primitives for geometry/layout
```

React owns application rendering/state boundaries. D3 is for packing, scales, and geometry rather than owning the UI.

## 32. Effect Architecture

Conceptual derivation:

```ts
const buildReplaySession = (
  session: Session,
  events: Stream.Stream<SessionEvent, BridgeError>
): Effect.Effect<
  ReplaySession,
  ReplayDerivationError
>
```

Pipeline:

```text
Bridge stream
  ↓
collect/index evidence
  ↓
derive file activity
  ↓
derive scenes
  ↓
derive chapters
  ↓
build stable map
  ↓
build timeline
  ↓
ReplaySession
```

Keep React state focused on interaction, not domain derivation.

Potential services:

```text
ReplayLoader
StoryDeriver
MapLayout
Narrator
ReviewStore
```

Do not turn simple pure functions into unnecessary services.

## 33. StoryDeriver

```ts
interface StoryDeriverShape {
  readonly derive: (
    session: Session,
    events: ReadonlyArray<SessionEvent>
  ) => Effect.Effect<ReplayStory, StoryDerivationError>
}
```

Default: `DeterministicStoryDeriver`.

Optional narration decorates deterministic output rather than replacing it.

## 34. MapLayout

```ts
interface MapLayoutShape {
  readonly layout: (
    files: ReadonlyArray<ReplayFile>
  ) => Effect.Effect<ReplayMap, MapLayoutError>
}
```

Same input must produce stable coordinates.

## 35. Suggested Structure

```text
examples/replay/
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   ├── routes.tsx
│   │   └── runtime.ts
│   ├── replay/
│   │   ├── model.ts
│   │   ├── derive.ts
│   │   ├── indexes.ts
│   │   ├── timeline.ts
│   │   └── errors.ts
│   ├── story/
│   │   ├── StoryDeriver.ts
│   │   ├── deterministic.ts
│   │   ├── chapters.ts
│   │   └── scenes.ts
│   ├── map/
│   │   ├── MapLayout.ts
│   │   ├── packing.ts
│   │   ├── activity.ts
│   │   └── relationships.ts
│   ├── playback/
│   │   ├── model.ts
│   │   ├── reducer.ts
│   │   ├── cursor.ts
│   │   └── shortcuts.ts
│   ├── review/
│   │   ├── ReviewStore.ts
│   │   └── local-storage.ts
│   ├── views/
│   │   ├── overview/
│   │   ├── story/
│   │   ├── changes/
│   │   └── events/
│   └── components/
│       ├── CodeMap/
│       ├── Timeline/
│       ├── DiffViewer/
│       ├── Terminal/
│       ├── ToolInspector/
│       └── EvidencePanel/
├── public/
├── fixtures/
├── index.html
├── package.json
└── README.md
```

## 36. Responsive Behavior

Desktop is the primary MVP target.

Tablet: story above map, sticky playback controls.

Mobile: story → active files → evidence, with the map as a dedicated fullscreen mode. Do not squeeze desktop map/prose side-by-side onto narrow screens.

## 37. Motion

Motion communicates state:

- map emphasis
- chapter/scene transitions
- timeline seeking
- selection
- map focus

Avoid perpetual decorative animation. Geography remains stationary while emphasis shifts. Respect reduced-motion preferences.

## 38. Large Sessions

Plan for 10k+ events, hundreds of files, and hours of activity.

Use:

- precomputed indexes
- memoized scene projections
- virtualized event lists
- lazy diff rendering
- map aggregation
- streamed loading where useful

MVP map scope is **files observed by the session**, not the entire repository. Repository-wide architecture indexing is a separate concern.

## 39. Example Derivation

Input:

```text
read auth.ts
read session.ts
read middleware.ts

change session.ts
change auth.ts

run pnpm test auth
exit 1

read auth.test.ts
change auth.ts

run pnpm test auth
exit 0
```

Derived story:

```text
Chapter 1 — Explored authentication
  Scene 1 — Read the existing auth flow

Chapter 2 — Changed session handling
  Scene 2 — Updated session.ts and auth.ts

Chapter 3 — Fixed failing authentication tests
  Scene 3 — Ran auth tests → failed
  Scene 4 — Inspected auth.test.ts and updated auth.ts
  Scene 5 — Re-ran auth tests → passed
```

Every scene links to canonical evidence.

## 40. MVP Scope

Ship:

- load Bridge session
- derive active files
- stable code map
- deterministic scenes
- deterministic chapters
- overview
- story walkthrough
- play/pause
- event/scene/chapter navigation
- file selection
- basic diff evidence
- command evidence
- raw event inspector
- local review state

No AI required.

Views:

```text
Overview
Story
Changes
Events
```

## 41. First Vertical Slice

Before the full UI:

```text
Bridge fixture
    ↓
Replay derivation
    ↓
3 chapters
    ↓
5–10 scenes
    ↓
stable file map
    ↓
click scene
    ↓
highlight relevant files
```

No playback animation, AI, or advanced diff yet.

If this is not useful, revisit the presentation model before building infrastructure.

## 42. Second Vertical Slice

Add:

- timeline
- play/pause
- previous/next scene
- active event
- command evidence
- diff evidence

At this point Replay should feel like watching work unfold.

## 43. Third Vertical Slice

Run against a real Claude Code session and a real Codex session.

Hard rule: no provider-specific Replay code.

Any leak is feedback for Bridge.

## 44. Acceptance Criteria

A user opening an unfamiliar session should be able to answer within minutes:

- What was attempted?
- What changed?
- Where did the agent work?
- What files mattered?
- What commands ran?
- Did validation succeed?
- Where did something fail?
- What evidence supports the story?

without reading the raw transcript end-to-end.

Architectural acceptance:

```text
✓ only public Bridge APIs
✓ Claude and Codex use identical Replay pipeline
✓ map coordinates stay stable between scenes
✓ every story scene references canonical evidence
✓ deterministic story works offline
✓ no LLM required
✓ missing/unknown events degrade gracefully
✓ one canonical playback cursor
✓ story/map/changes/events synchronize
✓ review state stays outside Bridge canonical data
```

## 45. Explicit Non-Goals

Replay MVP is not:

- an IDE
- coding-agent harness
- git client
- observability platform
- terminal emulator
- AI chat interface
- repository architecture analyzer
- replacement for code review

It is a way to understand work already performed by an agent.

## 46. Open Questions

Resolve through real sessions rather than blocking MVP:

- Are deterministic chapter heuristics good enough?
- Is directory grouping useful enough for map geography?
- Should default timeline emphasize source time or scene progression?
- Does Bridge expose enough diff information for intermediate file states?
- How much should agent prose influence scene boundaries?
- At what size should inactive map regions collapse?

## 47. Implementation Order

```text
1. scaffold examples/replay
2. load a Bridge fixture
3. define Replay domain model
4. build event indexes
5. derive file activity
6. stable map layout
7. render overview map
8. deterministic scene segmentation
9. deterministic chapter segmentation
10. story layout
11. scene ↔ map synchronization
12. evidence panel
13. changes view
14. event inspector
15. playback cursor
16. playback controls
17. keyboard navigation
18. review state
19. real Claude session test
20. real Codex session test
21. adjust Bridge only where canonical primitives are genuinely missing
22. optional narration experiment
```

## 48. Agent Instructions

1. Read Bridge's public API and canonical schemas first.
2. Never import provider adapters or provider schemas into Replay.
3. Treat Bridge events as immutable evidence.
4. Build Replay-specific derived models rather than adding presentation concepts to Bridge.
5. Keep chapter/scene derivation deterministic initially.
6. Every chapter and scene retains supporting Bridge event IDs.
7. Never invent intent when evidence supports only activity.
8. Prefer boring factual labels to speculative prose.
9. Compute map geography once per session and keep it stable.
10. Keep one canonical playback cursor and derive UI state from it.
11. Do not introduce an LLM dependency for MVP functionality.
12. Use Effect V4 for fallible derivation/runtime services without turning simple pure transforms into services.
13. Use React for UI and D3 only for geometry/layout where useful.
14. Optimize for understanding first, completeness second, spectacle third.
15. Test real Bridge sessions early.
16. If provider knowledge leaks into Replay, stop and evaluate Bridge instead of adding a provider hack.

## 49. Product Principle

The transcript answers:

> What events occurred?

The diff answers:

> What code changed?

Replay should answer:

> What happened here?

Then let the user inspect the evidence until they trust the answer.

## 50. North Star

A developer should be able to open a 45-minute coding-agent session they did not personally watch and, within a few minutes, build an accurate mental model of:

```text
the goal
the path taken
the code touched
the important transitions
the failures
the corrections
the final result
```

without reading hundreds of raw events.

That is Replay.
