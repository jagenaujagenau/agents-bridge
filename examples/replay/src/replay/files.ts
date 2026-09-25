/** Path, region and diff helpers. Pure and harness-agnostic. */

/** Paths inside the project become relative; everything else stays as observed. */
export const normalizePath = (projectPath: string | undefined) => (path: string): string => {
  if (projectPath === undefined) return path
  const prefix = projectPath.endsWith("/") ? projectPath : `${projectPath}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** Directory-level region, at most three segments deep so the map does not fragment. */
export const regionOf = (path: string): string => {
  const absolute = path.startsWith("/")
  const parts = path.split("/").filter((p) => p !== "")
  parts.pop()
  if (parts.length === 0) return absolute ? "/" : "."
  const region = parts.slice(0, absolute ? 4 : 3).join("/")
  return absolute ? `/${region}` : region
}

export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path

const languages: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", mdx: "markdown", css: "css", scss: "css", html: "html",
  py: "python", rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sh: "shell", zsh: "shell",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", vue: "vue", svelte: "svelte"
}

export const languageOf = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".")
  return dot > path.lastIndexOf("/") ? languages[path.slice(dot + 1).toLowerCase()] : undefined
}

export type DiffLine = {
  readonly kind: "add" | "del" | "ctx" | "hunk" | "meta"
  readonly text: string
}

const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

/** Whether `diff` is a unified diff, as opposed to the whole content of a created file. */
export const isUnifiedDiff = (diff: string): boolean => diff.split("\n").some((line) => hunkHeader.test(line))

/**
 * Hunk-aware unified diff parsing. Hunk headers say how many old and new lines follow,
 * so a changed line whose content starts with `---` or `+++` is still a change, while
 * `---`/`+++` file headers between hunks are metadata. Whole-file content (no hunks)
 * is all additions.
 */
export const parseDiff = (diff: string): ReadonlyArray<DiffLine> => {
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n")
  if (diff === "") return []
  if (!isUnifiedDiff(diff)) return lines.map((text) => ({ kind: "add", text: `+${text}` }))
  const out: Array<DiffLine> = []
  let oldLeft = 0
  let newLeft = 0
  for (const text of lines) {
    const header = hunkHeader.exec(text)
    if (oldLeft <= 0 && newLeft <= 0 && header !== null) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1])
      newLeft = header[2] === undefined ? 1 : Number(header[2])
      out.push({ kind: "hunk", text })
    } else if (text.startsWith("\\")) {
      out.push({ kind: "meta", text })
    } else if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("+")) {
        newLeft--
        out.push({ kind: "add", text })
      } else if (text.startsWith("-")) {
        oldLeft--
        out.push({ kind: "del", text })
      } else {
        oldLeft--
        newLeft--
        out.push({ kind: "ctx", text })
      }
    } else out.push({ kind: "meta", text })
  }
  return out
}

/** Added and removed lines of a diff (whole-file content counts as additions). */
export const diffStat = (diff: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const line of parseDiff(diff)) {
    if (line.kind === "add") additions++
    else if (line.kind === "del") deletions++
  }
  return { additions, deletions }
}
