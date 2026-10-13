/**
 * Apply a proposed change (ADR-0105): `POST` → `{ proposal }` with its
 * `results`, 409 unless it is still `proposed`. Every item runs through the
 * document, folder and assignment services in the caller's session. Thin
 * handler; the rules live in `@/lib/proposals/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { applyProposal } from '@/lib/proposals/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => ({ proposal: await applyProposal(session, params.id, request) }),
  {
    authz: {
      enforcedBy:
        'applyProposal (read gate + requireProjectAccess project:documents:write | project:edit; each item through its own service’s checks)',
    },
  }
)
