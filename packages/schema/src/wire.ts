import { Effect, Option, Schema } from "effect"
import { canonicalEventTypes, SessionEvent } from "./events.ts"
import { Session } from "./session.ts"

/**
 * JSON codecs for the wire format. Encoded values are plain JSON; decoding a
 * single JSONL line is the unit a non-Effect consumer reimplements.
 */

export const SessionEventJson = Schema.fromJsonString(SessionEvent)
export const SessionJson = Schema.fromJsonString(Session)

export const encodeEventLine = Schema.encodeSync(SessionEventJson)
export const decodeEventLine = Schema.decodeUnknownEffect(SessionEventJson)
export const encodeSessionJson = Schema.encodeSync(SessionJson)
export const decodeSessionJson = Schema.decodeUnknownEffect(SessionJson)

export const encodeEvent = Schema.encodeSync(SessionEvent)
export const decodeEvent = Schema.decodeUnknownEffect(SessionEvent)
export const validateEvent = Schema.decodeUnknownSync(SessionEvent)
export const validateSession = Schema.decodeUnknownSync(Session)

const TypedLine = Schema.fromJsonString(Schema.Struct({ type: Schema.String }))
const decodeTypedLine = Schema.decodeUnknownOption(TypedLine)
const known = new Set<string>(canonicalEventTypes)

/**
 * Forward-compatible line reader (§73): a line whose `type` is not known to
 * this protocol build decodes to `None`. Malformed known events still fail.
 */
export const decodeEventLineTolerant = (line: string) =>
  decodeEventLine(line).pipe(
    Effect.map(Option.some),
    Effect.catch((error) => {
      const typed = decodeTypedLine(line)
      const unknownType = Option.isSome(typed) && !known.has(typed.value.type) &&
        !typed.value.type.startsWith("custom.")
      return unknownType ? Effect.succeed(Option.none<SessionEvent>()) : Effect.fail(error)
    })
  )
