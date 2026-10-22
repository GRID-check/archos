/**
 * Archiv API — document-centric semantic search over the org's shared Archiv.
 * Thin handler; all logic lives in `@/lib/office-shelf/service` (ADR-0024).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { searchOfficeShelfSchema } from '@/lib/office-shelf/search-wire'
import { searchOfficeShelfDocuments } from '@/lib/office-shelf/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { q, topK } = await parseJsonBody(request, searchOfficeShelfSchema)
    return searchOfficeShelfDocuments(session, q, topK)
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only search over the caller's own org Archiv collection; scoped by session.organizationId",
    },
  }
)
