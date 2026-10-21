/**
 * Project memory item API — edit or delete a single memory item.
 * Thin handlers; authz and logic live in `@/lib/projects/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { editProjectMemoryItem, removeProjectMemoryItem } from '@/lib/projects/service'
import { patchMemorySchema } from '@/lib/projects/project-memory-wire'

type Params = { id: string; itemId: string }

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const patch = await parseJsonBody(request, patchMemorySchema)
    return { item: await editProjectMemoryItem(session, params.id, params.itemId, patch) }
  },
  { authz: { enforcedBy: 'editProjectMemoryItem (requireProjectAccess project:memory:write)' } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    await removeProjectMemoryItem(session, params.id, params.itemId)
  },
  { authz: { enforcedBy: 'removeProjectMemoryItem (requireProjectAccess project:memory:write)' } }
)
