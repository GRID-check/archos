/**
 * Stop an ask (ADR-0123): `POST` → the ask as `AskView`, `canceled` once its
 * turn stopped. 409 when it had already ended. Behind `piloti-ask-cancel` and
 * the A2A door's `CancelTask`. Thin handler; the rules live in
 * `@/lib/piloti-asks/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { cancelAsk } from '@/lib/piloti-asks/service'

export const dynamic = 'force-dynamic'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => cancelAsk(session, params.id),
  {
    authz: { enforcedBy: 'cancelAsk (the ask must be the session person’s own: requested_by = session.userId)' },
  },
)
