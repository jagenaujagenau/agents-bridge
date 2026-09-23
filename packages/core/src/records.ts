import { Option, Schema } from "effect"
import type { RecordScope } from "./normalize.ts"
import { parseJson, type SourceLine } from "./sources.ts"

/** One native record after provider decoding. Normalizers never see raw JSON. */
export type DecodedRecord<A> =
  | { readonly _tag: "Record"; readonly index: number; readonly record: A }
  | { readonly _tag: "Skip"; readonly index: number }
  | { readonly _tag: "Unknown"; readonly index: number; readonly nativeType: string }
  | {
    readonly _tag: "Malformed"
    readonly index: number
    readonly reason: "json" | "schema"
    readonly nativeType?: string | undefined
  }

export interface RecordDecoderOptions<S extends Schema.Top> {
  /** Provider schema for every known record type. */
  readonly schema: S
  /** How to read a record's native type. Defaults to the string `type` field. */
  readonly typeOf?: (json: unknown) => string | undefined
  /** Types decoded with `schema`. */
  readonly known: ReadonlySet<string>
  /** Types that carry no canonical meaning and are skipped silently. */
  readonly ignored: ReadonlySet<string>
}

const typeField = (json: unknown) =>
  typeof json === "object" && json !== null && "type" in json && typeof json.type === "string" ? json.type : undefined

/**
 * Decode one JSON value through a provider schema, classifying it as a record,
 * an ignored type, an unknown type, or malformed.
 */
export const makeRecordDecoder = <S extends Schema.Top & { readonly DecodingServices: never }>(
  options: RecordDecoderOptions<S>
) => {
  const decode = Schema.decodeUnknownOption(options.schema as unknown as Schema.Codec<S["Type"], unknown>)
  const typeOf = options.typeOf ?? typeField
  return (index: number, json: unknown): DecodedRecord<S["Type"]> => {
    const nativeType = typeOf(json)
    if (nativeType === undefined) return { _tag: "Malformed", index, reason: "schema" }
    if (options.ignored.has(nativeType)) return { _tag: "Skip", index }
    if (!options.known.has(nativeType)) return { _tag: "Unknown", index, nativeType }
    return Option.match(decode(json), {
      onNone: () => ({ _tag: "Malformed", index, reason: "schema", nativeType }),
      onSome: (record) => ({ _tag: "Record", index, record })
    })
  }
}

/** Decode a JSONL line: blank lines are skipped, invalid JSON is malformed. */
export const makeLineDecoder = <S extends Schema.Top & { readonly DecodingServices: never }>(
  options: RecordDecoderOptions<S>
) => {
  const decodeRecord = makeRecordDecoder(options)
  return ({ index, line }: SourceLine): DecodedRecord<S["Type"]> => {
    if (line.trim().length === 0) return { _tag: "Skip", index }
    const json = parseJson(line)
    return Option.isNone(json) ? { _tag: "Malformed", index, reason: "json" } : decodeRecord(index, json.value)
  }
}

/** Standard warnings for records a normalizer cannot use. */
export const warnUndecodable = (
  scope: RecordScope,
  decoded: Exclude<DecodedRecord<unknown>, { _tag: "Record" | "Skip" }>,
  harnessName: string
): void => {
  if (decoded._tag === "Unknown") {
    scope.warning("unknown_record_type", `Ignored unknown ${harnessName} record type "${decoded.nativeType}"`)
  } else if (decoded.reason === "json") {
    scope.warning("malformed_json", "Skipped lines that are not valid JSON")
  } else {
    scope.warning(
      "malformed_record",
      `Skipped records that do not match the expected ${decoded.nativeType ?? "record"} shape`
    )
  }
}

/** Text of content that is either a string or an array of `{text}` parts. */
export const textOf = (content: unknown, separator = "\n"): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []
    )
    .join(separator)
}

/** A string property of an unknown object, if present. */
export const stringProp = (value: unknown, ...keys: ReadonlyArray<string>): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  for (const key of keys) {
    const found = (value as Record<string, unknown>)[key]
    if (typeof found === "string") return found
  }
  return undefined
}

/** First line of a prompt, shortened, for use as a fallback title. */
export const titleFrom = (text: string): string => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

/** A non-negative integer token count from an untyped payload, or undefined. */
export const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined

/** Drop undefined counts so optional keys stay absent. */
export const usageFields = (fields: {
  readonly model?: string | undefined
  readonly inputTokens?: number | undefined
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
}) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as {
  readonly model?: string
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
}
