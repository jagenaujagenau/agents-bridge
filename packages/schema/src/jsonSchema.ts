import { Schema } from "effect"
import { SessionEvent } from "./events.ts"
import { BridgeSessionManifest, PROTOCOL_VERSION } from "./manifest.ts"
import { Session } from "./session.ts"
import { ImportWarning } from "./source.ts"

/** JSON Schema documents published under `schemas/v<version>/`. Derived, never hand-written. */
export const jsonSchemaDocuments = (): Record<string, unknown> => {
  const doc = (schema: Schema.Top, name: string) => {
    const document = Schema.toJsonSchemaDocument(schema)
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `https://agentbridge.dev/schemas/v${PROTOCOL_VERSION}/${name}.schema.json`,
      ...document.schema,
      $defs: document.definitions
    }
  }
  return {
    "session.schema.json": doc(Session, "session"),
    "event.schema.json": doc(SessionEvent, "event"),
    "manifest.schema.json": doc(BridgeSessionManifest, "manifest"),
    "import-warning.schema.json": doc(ImportWarning, "import-warning")
  }
}
