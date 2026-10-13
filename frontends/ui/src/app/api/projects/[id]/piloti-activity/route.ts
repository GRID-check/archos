/**
 * „Was Piloti tut" — what Piloti is doing in one project, as the reader may
 * see it: woken turns and runs in progress, proposals and proposed marks
 * waiting for a person, and what ended recently
 * (`docs/architecture/piloti-activity.md`).
 *
 * Thin adapter: the query is parsed here (`?since=`, `?limit=`, bounded by
 * `pilotiActivityQuerySchema`); `getPilotiActivity` authorizes (`project:view`),
 * gates every row for the reader and bounds every list.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getPilotiActivity } from '@/lib/piloti-activity/service'
import { pilotiActivityQuerySchema } from '@/lib/piloti-activity/types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) =>
    getPilotiActivity(session, params.id, parseQuery(request, pilotiActivityQuerySchema)),
  {
    authz: {
      enforcedBy: 'getPilotiActivity (requireProjectAccess project:view; rows gated per document and conversation)',
    },
  }
)
