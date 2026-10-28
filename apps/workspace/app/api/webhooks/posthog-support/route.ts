/**
 * PostHog Support's poke: a message was sent on a feedback ticket (ADR-0118,
 * second amendment).
 *
 * POST `{ "ticketId": "<uuid>" }`, from the PostHog workflow that reads the
 * ticket's `origin:<host>` tag. A thin adapter: the service finds the report,
 * reads the thread back from PostHog with the server's own key and tells the
 * reporter about team replies they have not seen (`notifyFeedbackReplies`).
 *
 * Answers 202 with no body whatever it found (a ticket of no report, nothing
 * new, a notice written), so the endpoint says nothing about which tickets
 * exist; 400 for a body that is not one ticket id, 429 past the rate limits,
 * 502 when PostHog cannot be read.
 */

import { publicApiRoute, parseJsonBody } from '@/lib/api/handler'
import { enforceLimit, POSTHOG_SUPPORT_POKE_LIMIT, POSTHOG_SUPPORT_POKE_TICKET_LIMIT } from '@/lib/limits'
import { notifyFeedbackReplies } from '@/lib/product-feedback/reply-notice'
import { posthogSupportPokeSchema } from '@/lib/product-feedback/types'

export const POST = publicApiRoute(
  async ({ request }) => {
    // The deployment's bucket first: a flood of made-up ids stops before any lookup.
    await enforceLimit(POSTHOG_SUPPORT_POKE_LIMIT, 'deployment')
    const { ticketId } = await parseJsonBody(request, posthogSupportPokeSchema)
    await enforceLimit(POSTHOG_SUPPORT_POKE_TICKET_LIMIT, `ticket:${ticketId.toLowerCase()}`)
    await notifyFeedbackReplies(ticketId.toLowerCase())
    return null
  },
  {
    why:
      'a poke that carries only a ticket id; the thread is read back from PostHog with the server key, so a forged ' +
      'poke can only make the server re-read a real ticket (ADR-0118, second amendment). Rate limited per ticket and per deployment',
    status: 202,
  }
)
