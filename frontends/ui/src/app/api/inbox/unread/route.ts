/**
 * `POST /api/inbox/unread` — mark items unread again („Als ungelesen
 * markieren“), the inverse of `POST /api/inbox/read { itemIds }`.
 *
 * Bounded like the read form, quiet for ids that are not the caller's, and
 * answered with the recomputed badge count. Gated per ITEM TYPE (see
 * `/api/inbox`).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { markUnreadSchema } from '@/lib/inbox/inbox-wire'
import { markUnread } from '@/lib/inbox/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { itemIds } = await parseJsonBody(request, markUnreadSchema)
    return markUnread(session, itemIds)
  },
  { authz: { enforcedBy: 'markUnread (rows are keyed to session.userId)' } }
)
