/**
 * „Ausmisten" before a project closes (ADR-0092): the person's decision, which
 * puts what they chose into the Papierkorb, all or nothing. The proposal is
 * `./proposal`. Thin handler; the rules live in `cleanup-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { confirmCleanup } from '@/lib/projects/cleanup-service'
import { confirmCleanupSchema } from '@/lib/projects/cleanup-wire'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, confirmCleanupSchema)
    return confirmCleanup(session, params.id, input, request)
  },
  { authz: { enforcedBy: 'confirmCleanup (requireProjectAccess project:documents:write; requireFolderWrite per folder)' } }
)
