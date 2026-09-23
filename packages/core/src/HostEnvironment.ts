import { Config, Context, Effect, Layer, Option } from "effect"

/**
 * Host facts adapters use to locate harness installs and history, read
 * through Effect `Config` so tests can supply a static environment.
 */
export interface HostEnvironmentShape {
  readonly home: string | undefined
  readonly pathEnv: string | undefined
  /** An environment variable, e.g. a harness directory override. */
  readonly variable: (name: string) => Effect.Effect<string | undefined>
}

export class HostEnvironment extends Context.Service<HostEnvironment, HostEnvironmentShape>()(
  "@agentbridge/core/HostEnvironment"
) {
  /** A fixed environment, for tests and embedding. */
  static readonly layer = (variables: Readonly<Record<string, string | undefined>> = {}) =>
    Layer.succeed(HostEnvironment, {
      home: variables["HOME"],
      pathEnv: variables["PATH"],
      variable: (name) => Effect.succeed(variables[name])
    })

  /** The active `ConfigProvider`, which is the process environment by default. */
  static readonly layerConfig: Layer.Layer<HostEnvironment> = Layer.effect(
    HostEnvironment,
    Effect.gen(function*() {
      const context = yield* Effect.context<never>()
      const variable = (name: string) =>
        Effect.gen(function*() {
          return Option.getOrUndefined(yield* Config.option(Config.String(name)))
        }).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.provideContext(context)
        )
      return {
        home: yield* variable("HOME"),
        pathEnv: yield* variable("PATH"),
        variable
      }
    })
  )

  /** The process environment with some variables replaced. */
  static readonly layerWithOverrides = (overrides: Readonly<Record<string, string | undefined>>) =>
    Layer.effect(
      HostEnvironment,
      Effect.gen(function*() {
        const base = yield* HostEnvironment
        return {
          home: overrides["HOME"] ?? base.home,
          pathEnv: overrides["PATH"] ?? base.pathEnv,
          variable: (name: string) =>
            name in overrides ? Effect.succeed(overrides[name]) : base.variable(name)
        }
      })
    ).pipe(Layer.provide(HostEnvironment.layerConfig))
}
