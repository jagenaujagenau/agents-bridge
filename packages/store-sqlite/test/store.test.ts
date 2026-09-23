import { storeContract } from "@agentbridge/testing"
import { SqliteSessionStore } from "../src/index.ts"

storeContract({ name: "SqliteSessionStore", layer: SqliteSessionStore.layer(":memory:") })
