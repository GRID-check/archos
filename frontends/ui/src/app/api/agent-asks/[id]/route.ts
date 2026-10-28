/**
 * One ask (ADR-0124): `GET ?waitSeconds=` → the ask as `AskView`, waiting up
 * to `waitSeconds` (at most `ASK_WAIT_SECONDS`) for it to end. The poll behind
 * `agent-ask-get` and the A2A door's `GetTask`. Only the person the ask was
 * made for reads it. Thin handler; the rules live in `@/lib/agent-asks/service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getAskQuerySchema } from '@/lib/agent-asks/ask-wire'
import { getAsk } from '@/lib/agent-asks/service'

export const dynamic = 'force-dynamic'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { waitSeconds } = parseQuery(request, getAskQuerySchema)
    return getAsk(session, params.id, waitSeconds ?? 0)
  },
  {
    authz: { enforcedBy: 'getAsk (the ask must be the session person’s own: requested_by = session.userId)' },
  },
)
