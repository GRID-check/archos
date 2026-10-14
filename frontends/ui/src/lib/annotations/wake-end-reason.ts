/**
 * Why a wake of Piloti ended without an answer, as a class a person can act on
 * (ADR-0106). Pure: the inbox words its `piloti.work_failed` notice by the
 * class (`lib/annotations/attention.ts`), never by the stored reason, which is
 * English, technical and meant for the audit trail.
 *
 * | Class | What the person reads | What they can do |
 * |---|---|---|
 * | `budget` | the usage budget is used up | ask whoever manages the organization to raise it |
 * | `busy` | Piloti did not get to it in time | ask again later |
 * | `access` | Piloti could not sign in on their behalf | ask again |
 * | `error` | the work broke off | ask again, or do it themselves |
 *
 * The reasons that can be stored on a wake (`piloti_wakes.reason`, at most 500
 * characters):
 *
 * - The wake job (`./wake-job.ts`): `budget: <the budget's message>` (refused
 *   before a turn ran); `gave up waiting: <why>` (failed, after its waits: a
 *   busy thread, a thread being deleted, no server, a socket that closed);
 *   `rejected: <code>[ (<message>)]` (failed: the chat socket refused the
 *   message; `auth_expired` and `conversation_mismatch` are the session and the
 *   signed envelope); the refusal's own words (refused: the socket's admission,
 *   or the agent's budget, said no before the turn answered).
 * - The turn's outcome (`lib/turns/outcome.ts`, posted by the chat socket): the
 *   refusal's words, `RUN_ERROR`'s message (`auth_error`, `token_expired`,
 *   `token_invalid` for an auth failure; a sentence for a deadline or a fault),
 *   `failed`, or `DEFAULT_FAILURE_REASON`.
 *
 * Anything else is `error`: the turn broke off without an answer.
 */

import type { PilotiWakeStatus } from './types'

export const WAKE_END_REASON_KINDS = ['budget', 'busy', 'access', 'error'] as const
export type WakeEndReasonKind = (typeof WAKE_END_REASON_KINDS)[number]

/** The refusals that say „not now": the socket's two admission pools, the turn fence, the research queue. */
const BUSY_REFUSALS = [
  /\bsend your message again in a moment\b/i,
  /\banswers in progress\b/i,
  /\bresearch jobs waiting\b/i,
]

/**
 * The class of a failed or refused wake's stored reason. Null for a wake that
 * did not end that way, and for a missing reason.
 */
export function wakeEndReasonKind(status: PilotiWakeStatus, reason: string | null): WakeEndReasonKind | null {
  if (status !== 'failed' && status !== 'refused') return null
  const text = reason?.trim()
  if (!text) return null
  // The job's own refusal (`budget: …`), and the agent's (`The organization's LLM budget is exhausted …`).
  if (/\bbudget\b/i.test(text)) return 'budget'
  if (/^gave up waiting\b/i.test(text)) return 'busy'
  if (BUSY_REFUSALS.some((pattern) => pattern.test(text))) return 'busy'
  if (/^rejected: (auth_expired|conversation_mismatch)\b/.test(text)) return 'access'
  if (/^(auth_error|token_expired|token_invalid)$/.test(text)) return 'access'
  return 'error'
}
