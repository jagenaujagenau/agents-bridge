import { type EventId, plainText, type SessionEvent } from "@agentbridge/schema"

/**
 * A request and the agent's closing reply to it: the last `agent.message` before the next
 * prompt. Turns without a reply (interrupted, or tool calls only) are left out.
 */
export interface ReplyTurn {
  readonly promptEventId: EventId
  readonly replyEventId: EventId
  readonly request: string
  readonly reply: string
  /** Sequence range of the turn, prompt to reply. */
  readonly startSequence: number
  readonly endSequence: number
}

/**
 * Agent messages written mid-turn, between actions: narration such as "Now let me run the
 * tests". Closing replies are excluded; they are judged as claims instead.
 */
export const narrationMessages = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<{ readonly eventId: EventId; readonly text: string }> => {
  const closing = new Set(replyTurns(events).map((t) => t.replyEventId))
  const out: Array<{ eventId: EventId; text: string }> = []
  for (const e of events) {
    if (e.type !== "agent.message" || closing.has(e.id)) continue
    const text = plainText(e.content).trim()
    if (text !== "") out.push({ eventId: e.id, text })
  }
  return out
}

export const replyTurns = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<ReplyTurn> => {
  const turns: Array<ReplyTurn> = []
  let prompt: SessionEvent | undefined
  let reply: SessionEvent | undefined
  const close = () => {
    if (prompt?.type === "user.message" && reply?.type === "agent.message") {
      const text = plainText(reply.content).trim()
      if (text !== "") {
        turns.push({
          promptEventId: prompt.id,
          replyEventId: reply.id,
          request: plainText(prompt.content).trim(),
          reply: text,
          startSequence: prompt.sequence,
          endSequence: reply.sequence
        })
      }
    }
  }
  for (const e of events) {
    if (e.type === "user.message") {
      close()
      prompt = e
      reply = undefined
    } else if (e.type === "agent.message") reply = e
  }
  close()
  return turns
}
