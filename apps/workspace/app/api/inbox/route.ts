/**
 * `GET /api/inbox` — one page of the caller's own inbox (spec IB-20).
 *
 * Whose inbox is never a parameter: the service reads it from the session, so
 * there is no id a caller could swap. `?filter=` picks the slice
 * (`InboxListFilter`: `requests` waits on the reader, `unread` is not opened
 * yet, `all` is everything unarchived, `archived` what was put away, `pending`
 * the badge's own set). `?type=` and `?projectId=` narrow it to one item type or one project;
 * `?limit=` sizes the page (at most 50) and `?cursor=` is the previous page's `nextCursor`.
 *
 * **There is deliberately no `requireCollaborationEnabled` here any more.** The
 * gate moved into the item-type registry (`@/lib/inbox/registry`'s `gate`) and
 * is applied by `listInbox` as a SQL type filter. A blanket 403 was wrong once
 * the inbox carried anything that is not a collaboration event: it made an
 * OPERATIONAL alert — "this organization is running out of storage" — silently
 * unreachable for exactly the tenants that have not bought a chat feature. A
 * tenant without collaboration now gets an inbox containing its operational
 * items and nothing else, which is the same guarantee NF-8 asked for, stated per
 * type instead of per route.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listInbox } from '@/lib/inbox/service'
import { inboxListQuerySchema } from '@/lib/inbox/inbox-wire'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { filter, cursor, type, projectId, limit } = parseQuery(request, inboxListQuerySchema)
    return listInbox(session, { filter: filter ?? 'all', cursor, type, projectId, limit })
  },
  { authz: { enforcedBy: 'listInbox (rows are keyed to session.userId)' } }
)
