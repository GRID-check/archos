/**
 * One proposed change (ADR-0105): `GET` → `{ proposal }`, as the reader may
 * see it, with `canDecide` for the card's buttons. Thin handler; the rules live
 * in `@/lib/proposals/service`, the contract in `@/lib/proposals/types`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getProposal } from '@/lib/proposals/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({ proposal: await getProposal(session, params.id) }),
  {
    authz: {
      enforcedBy:
        'getProposal (requireProjectAccess project:view on the proposal’s project + requireResourceAccess viewer on its conversation)',
    },
  }
)
