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

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { markReadSchema } from '@/lib/inbox/inbox-wire'
import { markAllRead, markAnchorItemsReadFor, markMarksSetReadFor, markRead } from '@/lib/inbox/service'

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
