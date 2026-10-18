/**
 * `GET /api/inbox/unread-anchors?resourceType=document&resourceId=…` — the
 * anchors inside one resource whose news the caller has not read, as
 * `{ anchorIds }`: for a document, the marks whose thread the review draws a
 * dot on. The read side of `POST /api/inbox/read`'s anchor form, which opening
 * a thread calls, over the same rows. Bounded (`UNREAD_ANCHORS_LIMIT`), and
 * gated per ITEM TYPE like every inbox route (see `/api/inbox`).
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { unreadAnchorsFor } from '@/lib/inbox/service'

const querySchema = z.object({
  // Only a document has marks today; a second anchored resource joins here, as on `/read`.
  resourceType: z.literal('document'),
  resourceId: z.string().min(1).max(200),
})

export const GET = apiRoute(
  async ({ session, request }) => {
    const { resourceType, resourceId } = parseQuery(request, querySchema)
    return unreadAnchorsFor(session, resourceType, resourceId)
  },
  { authz: { enforcedBy: 'unreadAnchorsFor (rows are keyed to session.userId)' } }
)
