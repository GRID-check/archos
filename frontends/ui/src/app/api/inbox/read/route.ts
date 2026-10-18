/**
 * `POST /api/inbox/read` — mark items read (spec IB-20).
 *
 * One endpoint for every shape because they are the same intent at different
 * granularities: `{ itemIds }` for the rows the user saw, `{ all: true }` for
 * "clear all", and `{ resourceType: 'document', resourceId, anchorId }` for
 * the news about one mark the reader just opened in the review (the
 * informational items anchored on it; a request survives being seen), and
 * `{ resourceType: 'document', resourceId, marksSet: true }` for the rows
 * about new marks on a document whose review the reader opened („Anna hat 15
 * Anmerkungen gesetzt“, which no mark's dot carries). The
 * response carries the recomputed badge count so the caller never needs a
 * follow-up read.
 *
 * Gated per ITEM TYPE rather than per route (see `/api/inbox`). `all: true`,
 * the anchor form and the new-marks form are scoped to the types the caller can see, so neither can
 * silently settle rows they were never shown.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { INBOX_LIST_LIMIT, markAllRead, markAnchorItemsReadFor, markMarksSetReadFor, markRead } from '@/lib/inbox/service'

/**
 * `itemIds` is bounded by the page size — a mark-read request can only ever be
 * about rows the client was actually shown, and an unbounded `IN (…)` is not
 * something a user-facing endpoint should accept.
 */
const markReadSchema = z.union([
  z.object({ itemIds: z.array(z.string().uuid()).min(1).max(INBOX_LIST_LIMIT) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
  z
    .object({
      // Only a document has marks today; a second anchored resource joins here.
      resourceType: z.literal('document'),
      resourceId: z.string().min(1).max(200),
      anchorId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      resourceType: z.literal('document'),
      resourceId: z.string().min(1).max(200),
      marksSet: z.literal(true),
    })
    .strict(),
])

export const POST = apiRoute(
  async ({ session, request }) => {
    const body = await parseJsonBody(request, markReadSchema)
    if ('all' in body) return markAllRead(session)
    if ('anchorId' in body) return markAnchorItemsReadFor(session, body.resourceType, body.resourceId, body.anchorId)
    if ('marksSet' in body) return markMarksSetReadFor(session, body.resourceType, body.resourceId)
    return markRead(session, body.itemIds)
  },
  {
    authz: {
      enforcedBy: 'markRead / markAllRead / markAnchorItemsReadFor / markMarksSetReadFor (rows are keyed to session.userId)',
    },
  }
)
