/**
 * The member's thread on one of their own feedback reports. Thin adapters
 * (ADR-0017); the thread lives on the report's PostHog Support ticket and the
 * service reads and writes it there (ADR-0118, amended).
 *
 * GET  — the thread: the report as typed, then the team's replies and the
 *        member's answers. Opening it counts as having seen it.
 * POST — the member answers. Masked against the office's policy before it
 *        leaves; bounded by `FEEDBACK_REPLY_LIMIT`.
 *
 * A report that is not the caller's own is a 404, a colleague's included.
 */

import { z } from 'zod'
import { NotFoundError } from '@/lib/api/errors'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FEEDBACK_REPLY_LIMIT } from '@/lib/limits/catalog'
import { getOwnProductFeedbackThread, replyToOwnProductFeedback } from '@/lib/product-feedback/service'
import { replyToProductFeedbackSchema } from '@/lib/product-feedback/types'

type Params = { reportId?: string | string[] }

/** A path segment that is not a uuid names nothing — 404, not a 500. */
function parseReportId(params: Params): string {
  const parsed = z.string().uuid().safeParse(params.reportId)
  if (!parsed.success) throw new NotFoundError('Unknown feedback report.')
  return parsed.data
}

export const GET = apiRoute<Params>(
  async ({ session, params }) => getOwnProductFeedbackThread(session, parseReportId(params)),
  {
    authz: { enforcedBy: 'getOwnProductFeedbackThread (the reporter only; rows keyed to session.userId)' },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { message } = await parseJsonBody(request, replyToProductFeedbackSchema)
    return replyToOwnProductFeedback(session, parseReportId(params), message)
  },
  {
    authz: { enforcedBy: 'replyToOwnProductFeedback (the reporter only; rows keyed to session.userId)' },
    limits: { rule: FEEDBACK_REPLY_LIMIT },
    status: 201,
  }
)
