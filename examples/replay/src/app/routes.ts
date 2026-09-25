/**
 * Hash routes (GOAL §30). Hash-based so the static build needs no server rewrites.
 *
 *   #/                                  session picker
 *   #/session/:id                       overview + story
 *   #/session/:id/story/:chapter
 *   #/session/:id/scene/:scene
 *   #/session/:id/event/:event
 *   #/session/:id/file?path=…
 *   #/session/:id/changes
 *   #/session/:id/events
 */

export type View = "story" | "changes" | "events"

export type Route =
  | { readonly page: "picker" }
  | { readonly page: "fleet"; readonly project?: string | undefined; readonly session?: string | undefined }
  | {
    readonly page: "session"
    readonly id: string
    readonly view: View
    readonly chapter?: string | undefined
    readonly scene?: string | undefined
    readonly event?: string | undefined
    readonly file?: string | undefined
  }

const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export const parseRoute = (hash: string): Route => {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?")
  const parts = path.split("/").filter((p) => p !== "")
  if (parts[0] === "fleet") {
    try {
      const params = new URLSearchParams(query)
      return { page: "fleet", project: params.get("project") ?? undefined, session: params.get("session") ?? undefined }
    } catch {
      return { page: "fleet" }
    }
  }
  if (parts[0] !== "session" || parts[1] === undefined) return { page: "picker" }
  const id = decode(parts[1])
  if (id === undefined) return { page: "picker" }
  const [kind, value] = [parts[2], parts[3] !== undefined ? decode(parts[3]) : undefined]
  let file: string | undefined
  try {
    file = new URLSearchParams(query).get("path") ?? undefined
  } catch {
    file = undefined
  }
  switch (kind) {
    case "changes":
    case "events":
      return { page: "session", id, view: kind, file }
    case "story":
      return { page: "session", id, view: "story", chapter: value, file }
    case "scene":
      return { page: "session", id, view: "story", scene: value, file }
    case "event":
      return { page: "session", id, view: "events", event: value }
    case "file":
      return { page: "session", id, view: "story", file }
    default:
      return { page: "session", id, view: "story" }
  }
}

export const sessionHref = (id: string, suffix = ""): string => `#/session/${encodeURIComponent(id)}${suffix}`

export const formatRoute = (route: Route): string => {
  if (route.page === "picker") return "#/"
  if (route.page === "fleet") {
    if (route.session !== undefined) return `#/fleet?session=${encodeURIComponent(route.session)}`
    return route.project !== undefined ? `#/fleet?project=${encodeURIComponent(route.project)}` : "#/fleet"
  }
  const file = route.file !== undefined ? `?path=${encodeURIComponent(route.file)}` : ""
  if (route.view === "changes" || route.view === "events") {
    if (route.view === "events" && route.event !== undefined) return sessionHref(route.id, `/event/${route.event}`)
    return sessionHref(route.id, `/${route.view}${file}`)
  }
  if (route.scene !== undefined) return sessionHref(route.id, `/scene/${route.scene}${file}`)
  if (route.chapter !== undefined) return sessionHref(route.id, `/story/${route.chapter}${file}`)
  if (route.file !== undefined) return sessionHref(route.id, `/file${file}`)
  return sessionHref(route.id)
}
