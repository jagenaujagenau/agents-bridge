import type { TourStep } from "../components/Tour.tsx"

/** The first-visit tour of a session's replay: what each part shows and how to read its marks. */
export const SESSION_TOUR_KEY = "replay:tour:session:v1"

export const sessionTour: ReadonlyArray<TourStep> = [
  {
    title: "Replay turns a session into a story you can check",
    body: (
      <p>
        An agent's session is thousands of events. Replay groups them into phases, places them on a map of the code, and
        links every statement back to the events behind it. This takes a minute; press <kbd>→</kbd> to go on or{" "}
        <kbd>Esc</kbd> to skip.
      </p>
    )
  },
  {
    target: ".overview",
    title: "Start with the briefing",
    body: (
      <p>
        What was asked, which files changed most, how every check ended at its last run, and what the agent said at the
        end. Each line opens its evidence. <b>(inferred)</b> marks a result read from output rather than recorded.
      </p>
    )
  },
  {
    target: ".chapters",
    title: "Chapters and scenes",
    body: (
      <p>
        The session in phases: exploring, changing code, validating, debugging. Scenes are the steps inside them. Titles
        describe what happened, never what the agent intended. Click a scene to jump there; ⚠ flags a claim the checks
        don't support.
      </p>
    )
  },
  {
    target: ".stage__map",
    title: "The code map",
    body: (
      <p>
        Every file the session touched, grouped by folder and sized by how much it was touched. Files in the current scene
        light up; a coloured dot means the file was changed. The layout never moves, so you can learn where things are.
      </p>
    )
  },
  {
    target: ".stage__detail",
    title: "The evidence",
    body: (
      <p>
        The proof behind the current scene: files and commands (Evidence), the change itself (Diff), the commands with
        their output (Terminal), and the raw tool call (Tool).
      </p>
    )
  },
  {
    target: ".playback",
    title: "Play it, or jump around",
    body: (
      <p>
        Press <kbd>Space</kbd> to watch the session unfold, or click the timeline. Coloured bands are chapters; red dots
        are failures. <kbd>←</kbd> <kbd>→</kbd> step through events, <kbd>J</kbd> <kbd>K</kbd> through chapters.
      </p>
    )
  },
  {
    target: ".views",
    title: "Two more ways in",
    body: (
      <p>
        <b>Changes</b> lists every diff, grouped by chapter or file, with a checkbox to mark each reviewed.{" "}
        <b>Events</b> shows the canonical events themselves, for when you want the raw record.
      </p>
    )
  },
  {
    target: ".views__fleet",
    title: "The fleet",
    body: <p>This session and every subagent it spawned, with each one's work over time.</p>
  },
  {
    title: "You're set",
    body: (
      <p>
        Hover a chapter or scene to mark it reviewed, or press <kbd>R</kbd>. Your review marks stay in this browser. The{" "}
        <b>Tour</b> button in the top bar replays this at any time.
      </p>
    )
  }
]
