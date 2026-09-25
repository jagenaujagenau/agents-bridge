import { useEffect, useMemo, useState } from "react"
import { fetchListing, fetchSummaries, type Listing, type SessionSummary } from "../app/api.ts"
import { ModelBadge } from "../components/ModelBadge.tsx"
import { modelLabel, vendorOf } from "../models/vendors.ts"
import { type SessionUsage, usageTotal } from "../replay/usage.ts"
import { sessionHref } from "../app/routes.ts"
import { formatDate } from "../components/format.ts"

const PAGE = 200
const BATCH = 50

/**
 * Title and usage for the rows on screen, fetched in batches so the first rows fill in quickly.
 * The server caches per session, so after the first visit this is one fast round trip.
 */
const useSummaries = (ids: ReadonlyArray<string>) => {
  const [usage, setUsage] = useState<Readonly<Record<string, SessionSummary | null>>>({})
  const key = ids.join("|")
  useEffect(() => {
    let live = true
    const missing = ids.filter((id) => !(id in usage))
    ;(async () => {
      for (let i = 0; i < missing.length && live; i += BATCH) {
        const got = await fetchSummaries(missing.slice(i, i + BATCH)).catch(() => ({}))
        if (live) setUsage((current) => ({ ...current, ...got }))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return usage
}

/** `/Users/me/code/app` → `~/code/app`. */
export const displayPath = (path: string, home: string | undefined): string =>
  home !== undefined && home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

const FolderIcon = () => (
  <svg className="folder" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.3l1.9 2H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
)

/** The project folder, trimmed from the start so the end of a long path stays visible. */
const PathCell = ({ path, home }: { path: string | undefined; home: string | undefined }) =>
  path === undefined
    ? <span className="picker__path muted">—</span>
    : (
      <span className="picker__path" title={path}>
        <FolderIcon />
        <span className="picker__path-text"><bdi>{displayPath(path, home)}</bdi></span>
      </span>
    )

/** Undefined while loading; null when nothing was recorded or the session could not be read. */
const usageOf = (summary: SessionSummary | null | undefined): SessionUsage | null | undefined =>
  summary === undefined ? undefined : summary?.usage ?? null

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
const full = new Intl.NumberFormat("en")

/** Undefined while loading, null when the session recorded no usage. */
const ModelCell = ({ usage, harness }: { usage: SessionUsage | null | undefined; harness: string }) => {
  if (usage === undefined) return <span className="picker__model muted">…</span>
  const [first, ...rest] = usage?.models ?? []
  if (first === undefined) {
    return <span className="picker__model muted" title={`${harness} did not record which model it used`}>—</span>
  }
  const title = [`${modelLabel(first.model)} · ${vendorOf(first.model).name} · run by ${harness}`, ...rest.map((m) => `also ${modelLabel(m.model)} (${compact.format(m.tokens)} tokens)`)].join("\n")
  return (
    <span className="picker__model" title={title}>
      <ModelBadge model={first.model} />
      {rest.length > 0 && <small className="muted">+{rest.length}</small>}
    </span>
  )
}

const TokensCell = ({ usage }: { usage: SessionUsage | null | undefined }) => {
  if (usage === undefined) return <span className="picker__tokens muted">…</span>
  if (usage === null) return <span className="picker__tokens muted" title="No token usage was recorded">—</span>
  const total = usageTotal(usage)
  const title = [
    `${full.format(total)} tokens over ${usage.calls} model call${usage.calls === 1 ? "" : "s"}`,
    `input ${full.format(usage.input)}`,
    `cache read ${full.format(usage.cacheRead)}`,
    `cache write ${full.format(usage.cacheWrite)}`,
    `output ${full.format(usage.output)}`
  ].join("\n")
  return <span className="picker__tokens mono" title={title}>{compact.format(total)}</span>
}

/** Every session Bridge can see, from every harness, through one list. */
export const SessionPicker = () => {
  const [listing, setListing] = useState<Listing | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [harness, setHarness] = useState<string>("all")
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState(PAGE)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setError(undefined)
    fetchListing().then(setListing, (e: unknown) => setError(String((e as Error).message ?? e)))
  }, [attempt])

  // Sessions someone started. Subagents are reached through their parent's fleet view.
  const sessions = useMemo(() => (listing?.sessions ?? []).filter((s) => s.parentSessionId === undefined), [listing])
  const names = useMemo(() => new Map(listing?.harnesses.map((h) => [h.id, h.name]) ?? []), [listing])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of sessions) m.set(s.harness, (m.get(s.harness) ?? 0) + 1)
    return m
  }, [sessions])
  const [titles, setTitles] = useState<Readonly<Record<string, string>>>({})
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions.filter((s) =>
      (harness === "all" || s.harness === harness) &&
      (needle === "" || s.id.toLowerCase().includes(needle) || (s.projectPath ?? "").toLowerCase().includes(needle) ||
        (titles[s.id] ?? "").toLowerCase().includes(needle))
    )
  }, [sessions, harness, query, titles])
  const shown = matching.slice(0, limit)
  const summaries = useSummaries(shown.map((s) => s.id))
  // Titles seen so far feed the filter; they arrive with the rows that have been on screen.
  useEffect(() => {
    const known = Object.fromEntries(Object.entries(summaries).flatMap(([id, s]) => (s != null ? [[id, s.title]] : [])))
    if (Object.keys(known).length !== Object.keys(titles).length) setTitles(known)
  }, [summaries, titles])

  return (
    <main className="picker">
      <header>
        <p className="eyebrow">
          Replay{listing?.source === "fixtures" ? " · fixtures" : ""} · <a href="#/fleet">Fleet view →</a>
        </p>
        <h1>What happened here?</h1>
        <p className="lede">
          Pick a coding-agent session. Replay reconstructs it as a story of chapters and scenes on a stable map of the code
          it touched, with every claim linked to the canonical Bridge events behind it.
        </p>
      </header>
      {error !== undefined && (
        <p className="error">
          Could not list sessions: {error} <button className="link" onClick={() => setAttempt(attempt + 1)}>Try again</button>
        </p>
      )}
      {listing === undefined && error === undefined && <p className="muted">Looking for sessions…</p>}
      {listing !== undefined && (
        <>
          <div className="picker__filters">
            <div className="segmented">
              <button className={harness === "all" ? "is-on" : ""} onClick={() => setHarness("all")}>
                All <small>{sessions.length}</small>
              </button>
              {[...counts].map(([id, n]) => (
                <button key={id} className={harness === id ? "is-on" : ""} onClick={() => setHarness(id)}>
                  {names.get(id) ?? id} <small>{n}</small>
                </button>
              ))}
            </div>
            <input className="filter" placeholder="Filter by title, path or id…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="picker__head" aria-hidden="true">
            <span>Last active</span>
            <span>Session</span>
            <span>Model</span>
            <span className="picker__tokens" title="Input, cached input and output tokens, summed over every model call">Tokens</span>
            <span>Path</span>
          </div>
          <ol className="picker__list">
            {shown.map((s) => (
              <li key={s.id}>
                <a href={sessionHref(s.id)} title={s.id}>
                  <span className="picker__when">{formatDate(s.updatedAt ?? s.startedAt)}</span>
                  <span className={`picker__title ${summaries[s.id] === undefined ? "muted" : ""}`}>
                    <span className="clip">{summaries[s.id] === undefined ? "…" : summaries[s.id]?.title ?? "Unreadable session"}</span>
                  </span>
                  <ModelCell usage={usageOf(summaries[s.id])} harness={names.get(s.harness) ?? s.harness} />
                  <TokensCell usage={usageOf(summaries[s.id])} />
                  <PathCell path={s.projectPath} home={listing.home} />
                </a>
              </li>
            ))}
          </ol>
          {shown.length === 0 && <p className="muted">No sessions match.</p>}
          {matching.length > shown.length && (
            <p className="picker__more">
              <span className="muted">Showing {shown.length} of {matching.length}</span>{" "}
              <button className="link" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, matching.length - shown.length)} more</button>
            </p>
          )}
        </>
      )}
    </main>
  )
}
