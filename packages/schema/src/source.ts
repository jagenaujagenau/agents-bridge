import { Schema } from "effect"

/** How authoritative a piece of normalized information is. */
export const Certainty = Schema.Literals(["known", "inferred", "unknown"])
export type Certainty = typeof Certainty.Type

/** Provenance of a normalized event. Never contains raw provider payloads. */
export const SourceReference = Schema.Struct({
  provider: Schema.String,
  format: Schema.String,
  sourceId: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  /** 0-based record (line / row) index inside the source, when meaningful. */
  recordIndex: Schema.optionalKey(Schema.Int),
  nativeEventId: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String)
}).pipe(Schema.annotate({ identifier: "SourceReference" }))
export type SourceReference = typeof SourceReference.Type

/** Pointer to raw source data, resolvable by the adapter that produced it. */
export const RawReference = Schema.Struct({
  kind: Schema.String,
  locator: Schema.String
}).pipe(Schema.annotate({ identifier: "RawReference" }))
export type RawReference = typeof RawReference.Type

/** A non-fatal compatibility problem found while importing a session. */
export const ImportWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  count: Schema.optionalKey(Schema.Int),
  source: Schema.optionalKey(SourceReference)
}).pipe(Schema.annotate({ identifier: "ImportWarning" }))
export type ImportWarning = typeof ImportWarning.Type
