import { Schema } from "effect"

/**
 * Provider schemas for Antigravity flat transcripts
 * (`~/.gemini/antigravity[-cli]/brain/<conversation>/.system_generated/logs/transcript[_full].jsonl`).
 *
 * Each record is a step. `USER_INPUT` and `PLANNER_RESPONSE` are the conversation;
 * other step types (`RUN_COMMAND`, `VIEW_FILE`, `CODE_ACTION`, …) hold a tool's output.
 * Tool calls on planner steps carry no call IDs, so outputs are paired by order.
 */

export const AntigravityToolCall = Schema.Struct({
  name: Schema.String,
  args: Schema.optionalKey(Schema.Unknown)
})
export type AntigravityToolCall = typeof AntigravityToolCall.Type

export const AntigravityStep = Schema.Struct({
  step_index: Schema.optionalKey(Schema.Number),
  source: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optionalKey(Schema.Array(AntigravityToolCall))
})
export type AntigravityStep = typeof AntigravityStep.Type
