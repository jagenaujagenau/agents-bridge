import { HarnessId, SessionId } from "@agentbridge/schema"
import { Schema } from "effect"

export class HarnessNotInstalled extends Schema.TaggedError<HarnessNotInstalled>()("HarnessNotInstalled", {
  harness: HarnessId
}) {}

export class AdapterUnavailable extends Schema.TaggedError<AdapterUnavailable>()("AdapterUnavailable", {
  harness: Schema.String,
  message: Schema.String
}) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  sessionId: Schema.String
}) {}

export class UnsupportedSessionVersion
  extends Schema.TaggedError<UnsupportedSessionVersion>()("UnsupportedSessionVersion", {
    harness: HarnessId,
    version: Schema.String
  })
{}

export class SessionParseError extends Schema.TaggedError<SessionParseError>()("SessionParseError", {
  harness: HarnessId,
  path: Schema.String,
  message: Schema.String
}) {}

export class SessionReadError extends Schema.TaggedError<SessionReadError>()("SessionReadError", {
  harness: HarnessId,
  path: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {}

export class CapabilityNotSupported extends Schema.TaggedError<CapabilityNotSupported>()("CapabilityNotSupported", {
  sessionId: SessionId,
  capability: Schema.String
}) {}

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  message: Schema.String
}) {}

export class ExportError extends Schema.TaggedError<ExportError>()("ExportError", {
  sessionId: Schema.String,
  destination: Schema.String,
  message: Schema.String
}) {}

/** A Bridge backend (e.g. a daemon) could not be reached or answered with something unreadable. */
export class BackendUnavailable extends Schema.TaggedError<BackendUnavailable>()("BackendUnavailable", {
  message: Schema.String
}) {}

export type AdapterError =
  | HarnessNotInstalled
  | SessionNotFound
  | UnsupportedSessionVersion
  | SessionParseError
  | SessionReadError

export type BridgeError =
  | AdapterError
  | BackendUnavailable
  | AdapterUnavailable
  | CapabilityNotSupported
  | StoreError
  | ExportError

/** Every `BridgeError` as a schema, so errors cross process boundaries as plain JSON. */
export const BridgeErrorSchema = Schema.Union([
  HarnessNotInstalled,
  SessionNotFound,
  UnsupportedSessionVersion,
  SessionParseError,
  SessionReadError,
  BackendUnavailable,
  AdapterUnavailable,
  CapabilityNotSupported,
  StoreError,
  ExportError
])

/** Render a platform/library failure as a message without leaking its object graph. */
export const describeCause = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}
