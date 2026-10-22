/**
 * Organization memory item — update or delete a single org-scoped item.
 * Tenancy comes from the session's organization id (the service scopes the
 * write in SQL). Thin handlers; logic lives in
 * `@/lib/projects/memory-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/api/errors'
import { deleteProjectMemoryItem, updateProjectMemoryItem } from '@/lib/projects/memory-service'
import { patchOrgMemorySchema } from '@/lib/organizations/organization-wire'
import { toMemoryWireItem } from '@/lib/projects/project-memory-wire'

type Params = { itemId: string }

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const patch = await parseJsonBody(request, patchOrgMemorySchema)
    const item = await updateProjectMemoryItem(
      { organizationId: session.organizationId },
      params.itemId,
      patch
    )
    if (!item) throw new NotFoundError()
    return { item: toMemoryWireItem(item) }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'org-scoped memory edit, keyed by session.organizationId; deliberately open to members like the create path',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    const deleted = await deleteProjectMemoryItem(
      { organizationId: session.organizationId },
      params.itemId
    )
    if (!deleted) throw new NotFoundError()
    // No body — apiRoute serializes this as a 204.
  },
  {
    authz: {
      sessionOnly: true,
      why: 'org-scoped memory delete, keyed by session.organizationId; deliberately open to members like the create path',
    },
  }
)
