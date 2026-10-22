/**
 * „Verlauf folgen“ (ADR-0134, D31): a person's standing decision about one
 * mail thread.
 *
 * POST   — follow the thread, or renew the caller's follow, for `days` (default
 *          60, at most 180 from the follow's start). While it runs, a later
 *          reply's text is appended as the caller when every condition of D31
 *          holds; attachments always wait for a person. Answers the follow and
 *          whether it was renewed. 404 for a thread the caller may not read,
 *          403 `project_closed` in a closed project.
 * DELETE — end the caller's follow, or (`?userId`, `project:manage`) someone
 *          else's. Ending a follow that is not running answers
 *          `endedFollowId: null`.
 *
 * Thin handler; the logic is `@/lib/mail-thread/follows`.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { followMailThread, unfollowMailThread } from '@/lib/mail-thread/follows'
import { mailThreadFollowBodySchema, mailThreadUnfollowQuerySchema } from '@/lib/mail-thread/mail-thread-wire'

type Params = { id: string; threadId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    // The body is optional: none follows for the default 60 days.
    const body = (await request.clone().text()).trim() ? await parseJsonBody(request, mailThreadFollowBodySchema) : {}
    return followMailThread(session, params.id, params.threadId, body)
  },
  {
    authz: {
      enforcedBy:
        'followMailThread -> requireMailReviewer (inbound-mail entitlement; project:documents:write any-of project:edit) + the thread readable + requireFolderWrite on its document’s folder (an open project)',
    },
  },
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) =>
    unfollowMailThread(session, params.id, params.threadId, parseQuery(request, mailThreadUnfollowQuerySchema)),
  {
    authz: {
      enforcedBy:
        'unfollowMailThread (inbound-mail entitlement; project:view; another person’s follow only with project:manage)',
    },
  },
)
