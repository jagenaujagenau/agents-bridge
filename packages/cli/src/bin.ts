#!/usr/bin/env node
import { BackendUnavailable } from "@agentbridge/core"
import { DaemonBridge, defaultSocket } from "@agentbridge/daemon"
import { NodeBridge } from "@agentbridge/platform-node"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { bridge } from "./cli.ts"

// `bridge events <id> | head` closes stdout early; that is a normal way to stop reading, not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0)
  throw error
})

// The index lives in $BRIDGE_DB (default ~/.bridge/bridge.db); it is only opened by commands that use it.
const embedded = NodeBridge.layer({ database: process.env["BRIDGE_DB"] ?? join(homedir(), ".bridge", "bridge.db") })

/**
 * Backend selection ($BRIDGE_DAEMON): `off` runs in-process; `on` requires the daemon;
 * `auto` (default) uses a running daemon and falls back to in-process. `bridge daemon …`
 * always runs in-process: the daemon is the embedded backend.
 */
const backend = () => {
  const mode = process.env["BRIDGE_DAEMON"] ?? "auto"
  const socket = defaultSocket(process.env, homedir())
  if (process.argv[2] === "daemon" || mode === "off" || (mode === "auto" && !existsSync(socket))) return embedded
  const remote = Layer.merge(DaemonBridge.layer({ socket }), NodeServices.layer).pipe(Layer.provide(NodeServices.layer))
  return mode === "on" ? remote : remote.pipe(Layer.catchCause(() => embedded))
}

bridge.pipe(
  Command.run({ version: "0.4.0" }),
  Effect.provide(backend()),
  Effect.catch((error) =>
    error instanceof BackendUnavailable
      ? Effect.sync(() => {
        console.error(`error: ${error.message}. Start one with \`bridge daemon start --detach\` or unset BRIDGE_DAEMON.`)
        process.exitCode = 1
      })
      : Effect.fail(error)),
  NodeRuntime.runMain
)
