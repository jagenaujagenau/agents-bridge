import { parseJson, type SourceLine } from "@agentbridge/core"
import { Option, Schema } from "effect"
import {
  Compacted,
  EVENT_MSG_TYPES,
  EventMsg,
  IGNORED_RESPONSE_ITEM_TYPES,
  RESPONSE_ITEM_TYPES,
  ResponseItem,
  RolloutLine,
  SessionMeta,
  TurnContext
} from "./schema/CodexRecord.ts"

interface At {
  readonly index: number
  readonly timestamp: string | undefined
}

/** One rollout line after provider decoding. */
export type DecodedLine =
  | At & { readonly _tag: "SessionMeta"; readonly meta: SessionMeta }
  | At & { readonly _tag: "TurnContext"; readonly context: typeof TurnContext.Type }
  | At & { readonly _tag: "ResponseItem"; readonly item: ResponseItem }
  | At & { readonly _tag: "Event"; readonly event: EventMsg }
  | At & { readonly _tag: "Compacted"; readonly compacted: typeof Compacted.Type }
  | At & { readonly _tag: "Ignored" }
  | At & { readonly _tag: "Unknown"; readonly nativeType: string }
  | At & { readonly _tag: "Malformed"; readonly reason: "json" | "schema"; readonly nativeType?: string }

const decodeLineShape = Schema.decodeUnknownOption(RolloutLine)
const decodeMeta = Schema.decodeUnknownOption(SessionMeta)
const decodeTurn = Schema.decodeUnknownOption(TurnContext)
const decodeItem = Schema.decodeUnknownOption(ResponseItem)
const decodeEvent = Schema.decodeUnknownOption(EventMsg)
const decodeCompacted = Schema.decodeUnknownOption(Compacted)

const payloadType = (payload: unknown): string | undefined =>
  typeof payload === "object" && payload !== null && "type" in payload && typeof payload.type === "string"
    ? payload.type
    : undefined

export const decodeLine = ({ index, line }: SourceLine): DecodedLine => {
  const blank = { index, timestamp: undefined }
  if (line.trim().length === 0) return { _tag: "Ignored", ...blank }
  const json = parseJson(line)
  if (Option.isNone(json)) return { _tag: "Malformed", reason: "json", ...blank }
  const shape = decodeLineShape(json.value)
  if (Option.isNone(shape)) return { _tag: "Malformed", reason: "schema", ...blank }
  const { payload, type } = shape.value
  const at = { index, timestamp: shape.value.timestamp }
  const malformed = (nativeType: string): DecodedLine => ({ _tag: "Malformed", reason: "schema", nativeType, ...at })

  switch (type) {
    case "session_meta":
      return Option.match(decodeMeta(payload), {
        onNone: () => malformed(type),
        onSome: (meta) => ({ _tag: "SessionMeta", meta, ...at })
      })
    case "turn_context":
      return Option.match(decodeTurn(payload), {
        onNone: () => malformed(type),
        onSome: (context) => ({ _tag: "TurnContext", context, ...at })
      })
    case "compacted":
      return Option.match(decodeCompacted(payload), {
        onNone: () => malformed(type),
        onSome: (compacted) => ({ _tag: "Compacted", compacted, ...at })
      })
    case "response_item": {
      const itemType = payloadType(payload) ?? "?"
      if (IGNORED_RESPONSE_ITEM_TYPES.has(itemType)) return { _tag: "Ignored", ...at }
      if (!RESPONSE_ITEM_TYPES.has(itemType)) return { _tag: "Unknown", nativeType: `response_item/${itemType}`, ...at }
      return Option.match(decodeItem(payload), {
        onNone: () => malformed(`response_item/${itemType}`),
        onSome: (item) => ({ _tag: "ResponseItem", item, ...at })
      })
    }
    case "event_msg": {
      // event_msg mirrors response_item for the UI. Only a few carry facts found nowhere else.
      const eventType = payloadType(payload) ?? "?"
      if (!EVENT_MSG_TYPES.has(eventType)) return { _tag: "Ignored", ...at }
      return Option.match(decodeEvent(payload), {
        onNone: () => malformed(`event_msg/${eventType}`),
        onSome: (event) => ({ _tag: "Event", event, ...at })
      })
    }
    default:
      return { _tag: "Unknown", nativeType: type, ...at }
  }
}
