import { parseJson, type SourceLine } from "@agentbridge/core"
import { Option, Schema } from "effect"
import { ClaudeRecord, METADATA_RECORD_TYPES, RecordType } from "./schema/ClaudeRecord.ts"

/** One physical line after provider decoding. The normalizer never sees raw JSON. */
export type DecodedLine =
  | { readonly _tag: "Record"; readonly index: number; readonly record: ClaudeRecord }
  | { readonly _tag: "Metadata"; readonly index: number; readonly nativeType: string }
  | { readonly _tag: "Unknown"; readonly index: number; readonly nativeType: string }
  | { readonly _tag: "Malformed"; readonly index: number; readonly reason: "json" | "schema"; readonly nativeType?: string }
  | { readonly _tag: "Blank"; readonly index: number }

const decodeRecord = Schema.decodeUnknownOption(ClaudeRecord)
const decodeType = Schema.decodeUnknownOption(RecordType)
const KNOWN_TYPES = new Set(["user", "assistant", "system", "ai-title", "custom-title", "summary", "continued-in"])

export const decodeLine = ({ index, line }: SourceLine): DecodedLine => {
  if (line.trim().length === 0) return { _tag: "Blank", index }
  const json = parseJson(line)
  if (Option.isNone(json)) return { _tag: "Malformed", index, reason: "json" }
  const type = decodeType(json.value)
  if (Option.isNone(type)) return { _tag: "Malformed", index, reason: "schema" }
  const nativeType = type.value.type
  if (METADATA_RECORD_TYPES.has(nativeType)) return { _tag: "Metadata", index, nativeType }
  if (!KNOWN_TYPES.has(nativeType)) return { _tag: "Unknown", index, nativeType }
  const record = decodeRecord(json.value)
  return Option.isSome(record)
    ? { _tag: "Record", index, record: record.value }
    : { _tag: "Malformed", index, reason: "schema", nativeType }
}
