/**
 * How a turn the BFF started ENDED (ADR-0106, amended by ADR-0109):
 * `POST /api/internal/turns/outcome`, posted by the chat socket on a headless
 * turn once it has persisted what it persists, and on `RUN_ERROR`, which
 * persists nothing.
 *
 * The BFF detaches from a woken turn once it runs (`headless-turn.ts`), so
 * this is the only way the wake learns its end. A turn the BFF did not start
 * (a browser's) does not post; one that does and is unknown is a no-op.
 *
 * Exported as `tests/fixtures/turn-outcome.schema.json` for the Python tier.
 */

import { z } from 'zod'

/**
 * The wire's terminal words (`RunFinishedBody.outcome` in
 * `packages/agent/src/agent/common/wire_v2.py`, plus `failed` for `RUN_ERROR`):
 * `answered`, `refused` (admission or the budget), `handed_off` (the turn
 * handed the work to a run), `stopped` (cancelled or superseded), `failed`.
 */
export const TURN_OUTCOMES = ['answered', 'refused', 'handed_off', 'stopped', 'failed'] as const
export type TurnOutcome = (typeof TURN_OUTCOMES)[number]

export const turnOutcomeRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(200),
    /** The turn id: the user message id the turn answered. A wake's id. */
    turnId: z.guid(),
    outcome: z.enum(TURN_OUTCOMES),
    /** Why, for `refused` and `failed`; user-safe, never a stack trace. */
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()
export type TurnOutcomeRequest = z.infer<typeof turnOutcomeRequestSchema>

/** `settled`: whether this outcome closed something the BFF started (false for an unknown or already-ended turn). */
export const turnOutcomeResponseSchema = z.object({ settled: z.boolean() }).strict()
export type TurnOutcomeResponse = z.infer<typeof turnOutcomeResponseSchema>
