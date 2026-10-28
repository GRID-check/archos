/**
 * `GET /api/inbox/unread-anchors?resourceType=document&resourceId=…` — the
 * anchors inside one resource whose news the caller has not read, as
 * `{ anchorIds }`: for a document, the marks whose thread the review draws a
 * dot on. The read side of `POST /api/inbox/read`'s anchor form, which opening
 * a thread calls, over the same rows. Bounded (`UNREAD_ANCHORS_LIMIT`), and
 * gated per ITEM TYPE like every inbox route (see `/api/inbox`).
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { unreadAnchorsQuerySchema } from '@/lib/inbox/inbox-wire'
import { unreadAnchorsFor } from '@/lib/inbox/service'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { resourceType, resourceId } = parseQuery(request, unreadAnchorsQuerySchema)
    return unreadAnchorsFor(session, resourceType, resourceId)
  },
  { authz: { enforcedBy: 'unreadAnchorsFor (rows are keyed to session.userId)' } }
)
