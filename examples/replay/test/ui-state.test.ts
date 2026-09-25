import { NodeBridge } from "@agentbridge/platform-node"
import type { EventId } from "@agentbridge/schema"
import { fixtureBridgeOptions, scenario } from "@agentbridge/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { formatRoute, parseRoute } from "../src/app/routes.ts"
import { reviewKey } from "../src/review/ReviewStore.ts"
import { displayPath } from "../src/views/SessionPicker.tsx"
import { initialState, makeReducer } from "../src/playback/reducer.ts"
import { loadReplaySession } from "../src/index.ts"

const layer = NodeBridge.layer(fixtureBridgeOptions)

describe("navigation state", () => {
  it.effect("opening an event selects its file and inspector, whichever view it came from (AUDIT #5)", () =>
    Effect.gen(function*() {
      const replay = yield* loadReplaySession(scenario.claude)
      const reduce = makeReducer(replay)
      const change = replay.events.find((e) => e.type === "file.changed")!
      const command = replay.events.find((e) => e.type === "command.started")!

      for (const view of ["events", "changes", "story"] as const) {
        const state = reduce({ ...initialState(view), selectedFile: "unrelated.ts" }, { type: "openEvent", eventId: change.id })
        expect(state).toMatchObject({ view: "story", selectedFile: "README.md", detail: "diff", started: true })
        expect(replay.timeline.entries[state.index]!.eventId).toBe(change.id)
      }
      expect(reduce(initialState("events"), { type: "openEvent", eventId: command.id })).toMatchObject({
        detail: "terminal",
        selectedFile: undefined
      })
    }).pipe(Effect.provide(layer)))

  it.effect("selecting a file on the map never moves playback", () =>
    Effect.gen(function*() {
      const replay = yield* loadReplaySession(scenario.claude)
      const reduce = makeReducer(replay)
      const playing = { ...initialState(), index: 5, started: true, status: "playing" as const }
      expect(reduce(playing, { type: "selectFile", path: "docs/usage.md" })).toMatchObject({ index: 5, status: "playing" })
    }).pipe(Effect.provide(layer)))

  it.effect("unknown events leave state unchanged", () =>
    Effect.gen(function*() {
      const replay = yield* loadReplaySession(scenario.claude)
      const state = initialState()
      expect(makeReducer(replay)(state, { type: "openEvent", eventId: "evt_missing" as EventId })).toBe(state)
    }).pipe(Effect.provide(layer)))
})

describe("review keys", () => {
  it.effect("name a scene by the event that opens it, not its position", () =>
    Effect.gen(function*() {
      const replay = yield* loadReplaySession(scenario.claude)
      const scene = replay.scenes[1]!
      expect(reviewKey(scene)).toBe(scene.eventIds[0])
      expect(reviewKey(scene)).toMatch(/^evt_/)
    }).pipe(Effect.provide(layer)))
})

describe("project paths", () => {
  it("shortens the home directory to ~, and nothing that merely starts like it", () => {
    expect(displayPath("/Users/me/code/app", "/Users/me")).toBe("~/code/app")
    expect(displayPath("/Users/me", "/Users/me")).toBe("~")
    expect(displayPath("/Users/meadow/app", "/Users/me")).toBe("/Users/meadow/app")
    expect(displayPath("/work/demo", undefined)).toBe("/work/demo")
  })
})

describe("routes", () => {
  it("round-trip a scene together with the selected file", () => {
    const route = { page: "session", id: "codex:abc", view: "story", scene: "sc4", file: "src/a b.ts" } as const
    expect(parseRoute(formatRoute(route))).toMatchObject({ id: "codex:abc", scene: "sc4", file: "src/a b.ts" })
  })

  it("malformed escapes fall back instead of throwing", () => {
    expect(parseRoute("#/session/%E0%A4%A")).toEqual({ page: "picker" })
    expect(parseRoute("#/session/codex%3Aabc/scene/sc3")).toMatchObject({ id: "codex:abc", scene: "sc3" })
  })
})
