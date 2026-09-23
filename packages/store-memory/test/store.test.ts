import { storeContract } from "@agentbridge/testing"
import { MemorySessionStore } from "../src/index.ts"

storeContract({ name: "MemorySessionStore", layer: MemorySessionStore.layer })
