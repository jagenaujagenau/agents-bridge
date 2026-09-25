import { layoutFleet } from "./layout.ts"
import type { Fleet } from "./model.ts"

/** Runs the fleet layout off the main thread, so the page stays responsive while it settles. */
const scope = self as unknown as { onmessage: ((e: MessageEvent<Fleet>) => void) | null; postMessage: (message: unknown) => void }
scope.onmessage = (event) => scope.postMessage([...layoutFleet(event.data)])
