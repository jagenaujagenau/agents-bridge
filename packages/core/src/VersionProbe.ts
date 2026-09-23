import { Context, Effect, Layer, Option } from "effect"

/**
 * Asks an installed harness binary for its version. A service so detection can
 * be tested without spawning processes; the Node implementation lives in
 * `@agentbridge/platform-node`.
 */
export interface VersionProbeShape {
  readonly probe: (executable: string, args: ReadonlyArray<string>) => Effect.Effect<Option.Option<string>>
}

export class VersionProbe extends Context.Service<VersionProbe, VersionProbeShape>()(
  "@agentbridge/core/VersionProbe"
) {
  /** Never probes. Detection reports no version. */
  static readonly layerNoop = Layer.succeed(VersionProbe, { probe: () => Effect.succeed(Option.none()) })

  static readonly layerStatic = (version: string) =>
    Layer.succeed(VersionProbe, { probe: () => Effect.succeed(Option.some(version)) })
}

/** Extract the first semver-looking token from `--version` output. */
export const parseVersionOutput = (output: string): Option.Option<string> => {
  const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(output)
  return match ? Option.some(match[0]) : Option.none()
}
