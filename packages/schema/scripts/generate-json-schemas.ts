import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { jsonSchemaDocuments, PROTOCOL_VERSION } from "../src/index.ts"

const outDir = fileURLToPath(new URL(`../../../schemas/v${PROTOCOL_VERSION}/`, import.meta.url))
mkdirSync(outDir, { recursive: true })
for (const [name, document] of Object.entries(jsonSchemaDocuments())) {
  writeFileSync(`${outDir}${name}`, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`wrote schemas/v${PROTOCOL_VERSION}/${name}`)
}
