/**
 * Stop the turn a wake of Piloti started, because a person took the mark back
 * (ADR-0106): the `piloti_wake_stop` job.
 *
 * The turn runs on the chat socket in the thread of the person whose act woke
 * Piloti, under the wake's id. An internal caller may stop any turn
 * (`may_act_for` in the backend's chat socket), so the job opens the socket as
 * one, with the smallest signed envelope that names the conversation: the
 * organization, the person and the thread. It builds no turn context
 * (`resolveTurnContext`), because a stop has no use for the collection scope,
 * the models or the budget, and must still land when the person who woke
 * Piloti has left the organization or their budget is spent.
 *
 * The turn ends `cancelled` on its own and reports it (`lib/turns/outcome.ts`
 * ends the wake `stopped`); this job never writes the wake. A turn that is no
 * longer running (`turn_not_found`) is the stop already done. Every other
 * answer that is not a sent stop throws, so the queue retries it and a dead
 * row shows a stop that never landed.
 */

import 'server-only'
import type { JobAttempt, AgentWakeStopPayload } from '@/lib/jobs-queue/types'
import { cancelHeadlessTurn, chatSocketUrl } from '@/lib/turns/headless-turn'
import { HEADLESS_MODE_HEADERS } from '@/lib/turns/headless-mode'
import { turnContextHeaders } from '@/lib/turns/turn-headers.js'
import { documentThreadConversationId } from './wake-ids'
import { findWake } from './wake-repository'

export async function runAgentWakeStop(
  organizationId: string,
  payload: AgentWakeStopPayload,
  _attempt: JobAttempt
): Promise<void> {
  const wake = await findWake(organizationId, payload.wakeId)
  // Ended already (answered, stopped, failed): nothing runs. A deleted mark took its wakes with it, and its turn may run.
  if (wake && wake.status !== 'started') return

  const secret = process.env.INTERNAL_API_TOKEN
  if (!secret) throw new Error('INTERNAL_API_TOKEN is not set: a stop cannot sign its socket')
  const conversationId = documentThreadConversationId(payload.documentId, payload.actorUserId)
  const outcome = await cancelHeadlessTurn({
    url: chatSocketUrl(conversationId),
    conversationId,
    turnId: payload.wakeId,
    headers: {
      ...turnContextHeaders({ organizationId, userId: payload.actorUserId, conversationId }, { issuedAt: Date.now(), secret }),
      ...HEADLESS_MODE_HEADERS,
    },
  })
  switch (outcome.kind) {
    case 'sent':
    case 'not_running':
      return
    case 'unavailable':
      throw new Error(`the stop of wake ${payload.wakeId} reached no server: ${outcome.reason}`)
    case 'rejected':
      throw new Error(
        `the chat socket refused the stop of wake ${payload.wakeId}: ${outcome.code}${outcome.message ? ` (${outcome.message})` : ''}`
      )
  }
}
