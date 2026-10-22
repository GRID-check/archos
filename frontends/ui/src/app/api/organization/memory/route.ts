/**
 * Organization-scoped memory — cross-cutting knowledge shared by every
 * project in the caller's organization. Tenancy comes from the session's
 * organization id; items are never visible across organizations. Any member
 * may read and write org memory (deliberately not admin-gated).
 *
 * Thin handlers; the write is `createOrganizationMemoryItem`
 * (`@/lib/projects/service`), the one an accepted memory proposal uses too.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { listOrganizationMemory } from '@/lib/projects/memory-service'
import { createOrganizationMemoryItem } from '@/lib/projects/service'
import { createOrgMemorySchema } from '@/lib/organizations/organization-wire'

export const GET = apiRoute(
  async ({ session, request }) => {
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true'
    return { items: await listOrganizationMemory(session.organizationId, { includeArchived }) }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'org-wide memory is shared by every project in the tenant and scoped by session.organizationId; deliberately not admin-gated',
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createOrgMemorySchema)
    const item = await createOrganizationMemoryItem(session, input)
    return { item }
  },
  {
    status: 201,
    authz: {
      sessionOnly: true,
      why: 'org-wide memory is shared by every project in the tenant and scoped by session.organizationId; deliberately not admin-gated',
    },
  }
)
