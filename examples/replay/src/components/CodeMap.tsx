import { memo, useEffect, useMemo, useRef, useState } from "react"
import { relatedFiles } from "../map/relationships.ts"
import { basename } from "../replay/files.ts"
import type { ReplaySession } from "../replay/model.ts"

/**
 * The persistent code map (GOAL §8–12). Geography comes precomputed from the
 * session and never moves; only emphasis changes with the cursor.
 */

interface Props {
  readonly replay: ReplaySession
  /** Files of the current scene. */
  readonly active: ReadonlySet<string>
  /** Mute files outside `active`. Off on the overview, where the whole map is the subject. */
  readonly dim: boolean
  /** File of the event under the cursor, pulsed once per cursor move. */
  readonly pulse?: string | undefined
  readonly pulseKey: number
  readonly selected?: string | undefined
  readonly onSelect: (path: string | undefined) => void
}

/** A label that fits inside a circle of `radiusPx` screen pixels, or the full name when the file is in focus. */
const fitLabel = (name: string, radiusPx: number, focused: boolean): string | undefined => {
  if (focused) return name
  const chars = Math.floor((2 * radiusPx - 8) / 7)
  if (chars >= name.length) return name
  return chars >= 7 ? `${name.slice(0, chars - 1)}…` : undefined
}

export const CodeMap = memo(function CodeMap({ replay, active, dim, pulse, pulseKey, selected, onSelect }: Props) {
  const [hovered, setHovered] = useState<string | undefined>()
  const focus = hovered ?? selected
  const related = useMemo(() => (focus === undefined ? [] : relatedFiles(replay, focus)), [replay, focus])
  const { nodes, regions, size } = replay.map
  // Labels and markers are sized in screen pixels, whatever size the map is drawn at.
  const svgRef = useRef<SVGSVGElement>(null)
  const [unit, setUnit] = useState(2)
  useEffect(() => {
    const el = svgRef.current
    if (el === null) return
    const observer = new ResizeObserver(() => el.clientWidth > 0 && setUnit((size + 20) / Math.min(el.clientWidth, el.clientHeight || el.clientWidth)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [size])

  if (nodes.size === 0) {
    return (
      <div className="map map--empty">
        <p>No files were read or changed in this session.</p>
      </div>
    )
  }

  const origin = focus !== undefined ? nodes.get(focus) : undefined
  return (
    <svg ref={svgRef} className="map" style={{ "--u": unit } as React.CSSProperties} viewBox={`-10 -10 ${size + 20} ${size + 20}`} role="group" aria-label="Code map of files touched in this session" onClick={() => onSelect(undefined)}>
      {regions.map((region) => (
        <g key={region.id} className="map__region">
          <circle cx={region.x} cy={region.y} r={region.radius} />
          {region.radius > 22 * unit && region.files.length > 1 && (
            <text x={region.x} y={region.y - region.radius - 6 * unit} textAnchor="middle">
              {region.id === "." ? "project root" : region.id}
            </text>
          )}
        </g>
      ))}
      {origin !== undefined && (
        <g className="map__edges">
          {related.map((path) => {
            const to = nodes.get(path)
            return to === undefined ? null : <line key={path} x1={origin.x} y1={origin.y} x2={to.x} y2={to.y} />
          })}
        </g>
      )}
      {[...nodes].map(([path, node]) => {
        const file = replay.files.get(path)!
        const isActive = active.has(path)
        const classes = [
          "map__file",
          dim && !isActive ? "is-muted" : "",
          isActive ? "is-active" : "",
          file.changeCount > 0 ? "is-changed" : "",
          selected === path ? "is-selected" : "",
          related.includes(path) ? "is-related" : ""
        ].join(" ")
        return (
          <g
            key={path}
            className={classes}
            role="button"
            tabIndex={0}
            aria-label={`${path}: ${file.readCount} reads, ${file.changeCount} changes`}
            aria-pressed={selected === path}
            onMouseEnter={() => setHovered(path)}
            onMouseLeave={() => setHovered(undefined)}
            onFocus={() => setHovered(path)}
            onBlur={() => setHovered(undefined)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onSelect(selected === path ? undefined : path)
              }
            }}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(selected === path ? undefined : path)
            }}
          >
            <title>{`${path}\n${file.readCount} reads · ${file.changeCount} changes`}</title>
            <circle cx={node.x} cy={node.y} r={node.radius} />
            {file.changeCount > 0 && (
              <circle className="map__marker" cx={node.x + node.radius * 0.7} cy={node.y - node.radius * 0.7} r={Math.min(Math.max(2.5 * unit, node.radius * 0.18), 5 * unit)} />
            )}
            {(() => {
              // In focus, the full path: a lone file's region is not labelled on the map.
              const focused = hovered === path || selected === path
              const label = focused ? path : fitLabel(basename(path), node.radius / unit, isActive)
              return label === undefined ? null : <text x={node.x} y={node.y + 4 * unit} textAnchor="middle">{label}</text>
            })()}
          </g>
        )
      })}
      {pulse !== undefined && nodes.get(pulse) !== undefined && (
        <circle key={pulseKey} className="map__pulse" cx={nodes.get(pulse)!.x} cy={nodes.get(pulse)!.y} r={nodes.get(pulse)!.radius} />
      )}
    </svg>
  )
})
