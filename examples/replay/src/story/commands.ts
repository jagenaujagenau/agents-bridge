/**
 * Generic shell command classification. Works on the canonical command text only,
 * so it applies to every harness that records commands.
 *
 * Validation is recognized conservatively, by executable and subcommand or script
 * name, never by a word appearing anywhere: `rm -rf build` and `touch test` are not
 * checks. When the shell's exit status cannot speak for the check (`pnpm test | tail`,
 * `pnpm test || true`), the check's result is unknown whatever the command's outcome.
 */

export type ValidationKind = "tests" | "typecheck" | "lint" | "build" | "checks"

export type CommandClass =
  | {
    readonly type: "validation"
    readonly kind: ValidationKind
    /** The check itself, e.g. `pnpm test auth`. Two runs are the same check when these match. */
    readonly check: string
    /** False when a pipe, `||` or `;` after the check decides the command's exit status. */
    readonly exitReflectsCheck: boolean
    /**
     * True when the check's pipeline is the last thing the command runs, so its recorded
     * output is the check's own. After `; nix build`, the tail belongs to something else.
     */
    readonly outputIsCheck: boolean
  }
  | { readonly type: "read" }
  | { readonly type: "other" }

const readOnly = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "ag", "find", "fd", "tree", "wc", "pwd", "which", "file",
  "stat", "du", "less", "more", "bat", "jq", "nl", "sort", "uniq", "diff", "echo", "printf"
])
const readOnlyGit = new Set(["status", "diff", "log", "show", "blame", "branch", "ls-files", "rev-parse", "grep"])

interface Segment {
  readonly tokens: ReadonlyArray<string>
  /** The operator after this segment, if another segment follows. */
  readonly next?: string | undefined
}

/** Heredoc bodies are data, not commands: keep only the line that starts one. */
const withoutHeredoc = (command: string): string =>
  /<<-?\s*['"]?\w+/.test(command) ? command.split("\n")[0]! : command

/** Command segments joined by `&&`, `||`, `;`, pipes or newlines, with quoted text removed. */
const parse = (command: string): ReadonlyArray<Segment> => {
  const parts = withoutHeredoc(command).replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "\"\"").split(/(&&|\|\||;|\||\n)/)
  const out: Array<Segment> = []
  for (let i = 0; i < parts.length; i += 2) {
    const tokens = parts[i]!.trim().split(/\s+/).filter((t) => t !== "" && !/^\w+=/.test(t))
    if (tokens.length === 0) continue
    out.push({ tokens, next: i + 2 < parts.length ? parts[i + 1] : undefined })
  }
  return out.filter((s) => s.tokens[0] !== "cd")
}

export const segments = (command: string): ReadonlyArray<ReadonlyArray<string>> => parse(command).map((s) => s.tokens)

const tools: Record<string, ValidationKind> = {
  vitest: "tests", jest: "tests", pytest: "tests", mocha: "tests", ava: "tests", rspec: "tests", phpunit: "tests",
  playwright: "tests", cypress: "tests",
  tsc: "typecheck", tsgo: "typecheck", "vue-tsc": "typecheck", mypy: "typecheck", pyright: "typecheck",
  eslint: "lint", oxlint: "lint", biome: "lint", ruff: "lint", rubocop: "lint", "golangci-lint": "lint", stylelint: "lint"
}

/** Script and make-target names: `test:unit`, `typecheck`, `lint:fix`, `build`, `check`. */
const scriptKind = (name: string | undefined): ValidationKind | undefined => {
  if (name === undefined) return undefined
  // A prefix, then a separator or a camelCase boundary: `test:unit`, `testDebugUnitTest`, not `testimonials`.
  const is = (prefix: string) => new RegExp(`^(${prefix})(?![a-z])`).test(name)
  if (is("tests?|e2e|spec")) return "tests"
  if (is("typecheck|type-check|tsc|types")) return "typecheck"
  if (is("lint")) return "lint"
  if (is("build|compile|assemble")) return "build"
  if (is("check|verify|validate|ci")) return "checks"
  return undefined
}

/** Flags that take a value, so the value is not mistaken for a subcommand. */
const valueFlags = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "--cwd", "-w", "--workspace", "-p", "--package", "--manifest-path"])

const positionals = (tokens: ReadonlyArray<string>): Array<string> => {
  const out: Array<string> = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith("-")) {
      if (valueFlags.has(t)) i++
      continue
    }
    out.push(t)
  }
  return out
}

const runners = new Set(["npx", "bunx", "pnpx", "time", "env", "nice"])

/** Build tools whose first positional argument names the step: `gleam test`, `mix compile`. */
const subcommands: Record<string, Record<string, ValidationKind>> = {
  cargo: { test: "tests", nextest: "tests", clippy: "lint", check: "typecheck", build: "build" },
  go: { test: "tests", vet: "lint", build: "build" },
  deno: { test: "tests", check: "typecheck", lint: "lint" },
  gleam: { test: "tests", check: "typecheck", build: "build" },
  vite: { build: "build" },
  next: { build: "build", lint: "lint" },
  astro: { build: "build", check: "typecheck" },
  nuxt: { build: "build", typecheck: "typecheck" },
  tsup: { build: "build" },
  mix: { test: "tests", compile: "build", credo: "lint", dialyzer: "typecheck" },
  dune: { test: "tests", build: "build" },
  swift: { test: "tests", build: "build" },
  zig: { build: "build", test: "tests" },
  bazel: { test: "tests", build: "build" },
  bazelisk: { test: "tests", build: "build" },
  stack: { test: "tests", build: "build" },
  cabal: { test: "tests", build: "build" },
  flutter: { test: "tests", analyze: "lint", build: "build" },
  dart: { test: "tests", analyze: "lint" }
}

const validationKind = (tokens: ReadonlyArray<string>): ValidationKind | undefined => {
  const [head, ...rest] = tokens
  if (head === undefined) return undefined
  const args = positionals(rest)
  // `./node_modules/.bin/tsc` is `tsc`; `./gradlew` is `gradlew`.
  const exe = head.slice(head.lastIndexOf("/") + 1)
  if (tools[exe] !== undefined) return tools[exe]
  if (runners.has(exe)) return validationKind(args)
  if ((exe === "python" || exe === "python3") && rest[0] === "-m") {
    return rest[1] === "unittest" ? "tests" : validationKind(rest.slice(1))
  }
  if (exe === "node" && rest.includes("--test")) return "tests"
  if (exe === "bundle" && args[0] === "exec") return validationKind(args.slice(1))
  if (exe === "xcodebuild") return args.includes("test") ? "tests" : args.includes("build") ? "build" : undefined
  if (exe === "rake") return scriptKind(args[0])
  if ((exe === "uv" || exe === "poetry" || exe === "pipenv") && args[0] === "run") return validationKind(args.slice(1))
  // `nix develop -c gleam test`, `direnv exec . pnpm test`, `timeout 60 pnpm test`
  if (exe === "nix" && args[0] === "build") return "build"
  if (exe === "nix" && args[0] === "flake" && args[1] === "check") return "checks"
  if (exe === "nix" && args[0] === "develop") {
    const at = rest.findIndex((t) => t === "-c" || t === "--command")
    return at >= 0 ? validationKind(rest.slice(at + 1)) : undefined
  }
  if (exe === "direnv" && args[0] === "exec") return validationKind(args.slice(2))
  if (exe === "timeout") return validationKind(args.slice(1))
  if (subcommands[exe] !== undefined) {
    // `zig build test` runs tests through the build step.
    if (exe === "zig" && args[0] === "build" && args[1] === "test") return "tests"
    return args[0] !== undefined ? subcommands[exe][args[0]] : undefined
  }
  switch (exe) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun": {
      const [sub, script] = args
      if (sub === "exec" || sub === "dlx" || sub === "x") return validationKind(args.slice(1))
      if (sub === "test" || sub === "t") return "tests"
      if (sub === "run" || sub === "run-script") return scriptKind(script)
      return exe === "npm" ? undefined : scriptKind(sub)
    }
    case "gradle":
    case "gradlew":
      // Task paths: `:app:testDebugUnitTest` runs `testDebugUnitTest`.
      return scriptKind(args[0]?.slice(args[0].lastIndexOf(":") + 1))
    case "dotnet":
    case "mvn":
    case "make":
    case "just":
    case "task":
      return scriptKind(args[0])
    default:
      return undefined
  }
}

const isReadOnly = (tokens: ReadonlyArray<string>): boolean => {
  const [head, sub] = tokens
  if (head === undefined) return false
  if (tokens.some((t) => /^\d?>/.test(t) && !/^\d?>&\d$/.test(t))) return false
  if (head === "sed") return tokens.includes("-n") && !tokens.some((t) => t.startsWith("-i"))
  if (head === "git") return sub !== undefined && readOnlyGit.has(sub)
  return readOnly.has(head)
}

/**
 * The check itself, without wrappers that do not change what is checked:
 * `nix develop -c gleam build`, `timeout 60 pnpm test` and `npx tsc` are the same
 * checks as `gleam build`, `pnpm test` and `tsc`. Output redirections are dropped too.
 */
const checkIdentity = (tokens: ReadonlyArray<string>): string => {
  let t = tokens.filter((x) => !/^\d?>/.test(x))
  for (;;) {
    const [head, second] = t
    if (head === "nix" && second === "develop") {
      const at = t.findIndex((x) => x === "-c" || x === "--command")
      if (at < 0) break
      t = t.slice(at + 1)
    } else if (head === "direnv" && second === "exec") t = t.slice(3)
    else if (head === "timeout") t = t.slice(2)
    else if (head === "pnpm" && second === "exec") t = t.slice(2)
    else if (head !== undefined && ["npx", "bunx", "pnpx", "time", "env", "nice"].includes(head)) t = t.slice(1)
    else break
  }
  return t.join(" ")
}

/** The segment at `i` as a check of `kind`: its identity, and whether exit status and output are its own. */
const checkAt = (parts: ReadonlyArray<Segment>, i: number, kind: ValidationKind, pipefail: boolean): CommandClass => {
  const part = parts[i]!
  const masked = part.next !== undefined && part.next !== "&&" && !(part.next === "|" && pipefail)
  // A later `||` swallows this check's failure too: `pnpm test && pnpm lint || true`.
  const swallowed = parts.slice(i + 1).some((p) => p.next === "||" || p.next === ";")
  let end = i
  while (parts[end]!.next === "|" && end + 1 < parts.length) end++
  return {
    type: "validation",
    kind,
    check: checkIdentity(part.tokens),
    exitReflectsCheck: !masked && !swallowed,
    outputIsCheck: parts[end]!.next === undefined
  }
}

export const classifyCommand = (command: string): CommandClass => {
  const parts = parse(command)
  const pipefail = /pipefail/.test(command)
  for (const [i, part] of parts.entries()) {
    const kind = validationKind(part.tokens)
    if (kind !== undefined) return checkAt(parts, i, kind, pipefail)
  }
  return parts.length > 0 && parts.every((p) => isReadOnly(p.tokens)) ? { type: "read" } : { type: "other" }
}

/**
 * A command the rules did not recognise, treated as a check of `kind` because a judgment
 * said so (see `checkCandidate`). Exit status and output are assessed as for known checks.
 */
export const classifyAs = (command: string, kind: ValidationKind): CommandClass => {
  const parts = parse(command)
  const candidate = checkCandidate(command)
  const i = parts.findIndex((p) => p.tokens.join(" ") === candidate)
  return i < 0 ? { type: "other" } : checkAt(parts, i, kind, /pipefail/.test(command))
}

/**
 * The first command segment that could be a check the rules do not know: a script file
 * run by an interpreter, a `./scripts/…` executable, or an unrecognised package script or
 * make target. Inline scripts (`python3 -`, `node -e`), file operations, git and network
 * calls are never candidates. Only these are worth asking a model about.
 */
export const checkCandidate = (command: string): string | undefined => {
  const interpreters = new Set(["python", "python3", "node", "bun", "deno", "tsx", "ts-node", "bash", "sh", "zsh", "ruby", "perl"])
  const scriptFile = /\.(py|js|mjs|cjs|ts|mts|sh|bash|rb|pl)$/
  for (const tokens of segments(command)) {
    if (classifyCommand(tokens.join(" ")).type !== "other") continue
    const [head, ...rest] = tokens
    if (head === undefined) continue
    const args = positionals(rest)
    const runner = head === "npx" || head === "bunx" ? args[0] : undefined
    if (runner === "tsx" || runner === "ts-node") return scriptFile.test(args[1] ?? "") ? tokens.join(" ") : undefined
    if (interpreters.has(head) && !rest.some((t) => t === "-" || t === "-c" || t === "-e" || t === "--eval")) {
      if (scriptFile.test(args[0] ?? "")) return tokens.join(" ")
    }
    if (/^(\.\/|scripts\/|bin\/)/.test(head) && !head.endsWith(".md")) return tokens.join(" ")
    if (["npm", "pnpm", "yarn", "bun"].includes(head) && !rest.some((t) => t === "-e" || t === "--eval") &&
      (args[0] === "run" ? args[1] : args[0]) !== undefined) {
      const script = args[0] === "run" ? args[1]! : args[0]!
      const builtins = ["install", "i", "add", "remove", "rm", "update", "upgrade", "view", "info", "init", "create", "dlx", "exec", "x", "link", "publish", "pack", "outdated", "why", "list", "ls", "config", "cache", "audit", "ci", "dev", "start", "serve", "preview", "--version", "-v"]
      if (!builtins.includes(script) && args[0] !== "-e") return tokens.join(" ")
    }
    if ((head === "make" || head === "just") && args[0] !== undefined) return tokens.join(" ")
  }
  return undefined
}

export const validationLabel: Record<ValidationKind, string> = {
  tests: "tests",
  typecheck: "the typecheck",
  lint: "the linter",
  build: "the build",
  checks: "checks"
}

const searchTools = new Set(["grep", "rg", "ag", "find", "fd"])

/** "Searched with grep" / "Inspected with ls and cat", from the programs a read-only command ran. */
export const inspectionLabel = (commands: ReadonlyArray<string>): string => {
  const heads = [...new Set(commands.flatMap((c) => segments(c).map((t) => (t[0] === "git" ? `git ${t[1] ?? ""}`.trim() : t[0]!))))]
  const verb = heads.every((h) => searchTools.has(h)) ? "Searched" : "Inspected"
  const shown = heads.slice(0, 3)
  const list = heads.length > 3
    ? `${shown.join(", ")} and more`
    : shown.length <= 1
    ? shown.join("")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
  return `${verb} with ${list}`
}

/** First line of a command without a leading `cd …&&`, shortened for titles. */
export const shortCommand = (command: string, max = 48): string => {
  const line = (command.trim().split("\n")[0] ?? "").replace(/^cd\s+\S+\s*&&\s*/, "")
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
