import { useMemo, useState } from "react"
import { type DiffLine, parseDiff } from "../replay/files.ts"

/** Unified or split rendering of a canonical `diff` (a unified diff, or whole-file content for created files). */

type Line = DiffLine
type Row = { readonly left?: Line | undefined; readonly right?: Line | undefined }

/** Pair each run of removals with the additions that follow it. */
const split = (lines: ReadonlyArray<Line>): Array<Row> => {
  const rows: Array<Row> = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    if (line.kind === "meta") {
      rows.push({ left: line })
      i++
      continue
    }
    if (line.kind !== "del" && line.kind !== "add") {
      rows.push({ left: line, right: line })
      i++
      continue
    }
    const dels: Array<Line> = []
    const adds: Array<Line> = []
    while (lines[i]?.kind === "del") dels.push(lines[i++]!)
    while (lines[i]?.kind === "add") adds.push(lines[i++]!)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] })
  }
  return rows
}

const MAX_LINES = 1500

export const DiffViewer = ({ diff, path }: { readonly diff: string | undefined; readonly path: string }) => {
  const [mode, setMode] = useState<"unified" | "split">("unified")
  const [all, setAll] = useState(false)
  const lines = useMemo(() => (diff === undefined ? [] : parseDiff(diff)), [diff])
  if (diff === undefined) {
    return <p className="muted">The session recorded that {path} changed, but not how.</p>
  }
  // Very long diffs render the first part until asked; nothing is dropped from the evidence.
  const shown = all ? lines : lines.slice(0, MAX_LINES)
  return (
    <div className="diff">
      <div className="diff__bar">
        <span className="mono">{path}</span>
        <div className="segmented">
          <button className={mode === "unified" ? "is-on" : ""} onClick={() => setMode("unified")}>Unified</button>
          <button className={mode === "split" ? "is-on" : ""} onClick={() => setMode("split")}>Split</button>
        </div>
      </div>
      {mode === "unified"
        ? (
          <pre className="diff__body">
            {shown.map((l, i) => <div key={i} className={`diff__line is-${l.kind}`}>{l.text || " "}</div>)}
          </pre>
        )
        : (
          <div className="diff__split">
            {split(shown).map((row, i) => (
              <div key={i} className="diff__row">
                <pre className={`diff__line is-${row.left?.kind ?? "empty"}`}>{row.left?.text ?? ""}</pre>
                <pre className={`diff__line is-${row.right?.kind ?? "empty"}`}>{row.right?.text ?? ""}</pre>
              </div>
            ))}
          </div>
        )}
      {!all && lines.length > MAX_LINES && (
        <p className="muted diff__more">
          {lines.length - MAX_LINES} more lines. <button className="link" onClick={() => setAll(true)}>Show all {lines.length}</button>
        </p>
      )}
    </div>
  )
}
