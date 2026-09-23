#!/usr/bin/env node
import { NodeBridge } from "@agentbridge/platform-node"
import { NodeRuntime } from "@effect/platform-node"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { bridge } from "./cli.ts"

// `bridge events <id> | head` closes stdout early; that is a normal way to stop reading, not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0)
  throw error
})

bridge.pipe(
  Command.run({ version: "0.2.0" }),
  // The index lives in $BRIDGE_DB (default ~/.bridge/bridge.db); it is only opened by commands that use it.
  Effect.provide(NodeBridge.layer({ database: process.env["BRIDGE_DB"] ?? join(homedir(), ".bridge", "bridge.db") })),
  NodeRuntime.runMain
)
