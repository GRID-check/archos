/**
 * Archiv API — document-centric semantic search over the org's shared Archiv.
 * Thin handler; all logic lives in `@/lib/office-shelf/service` (ADR-0024).
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { searchOfficeShelfDocuments } from '@/lib/office-shelf/service'

const searchBodySchema = z.object({
  q: z.string().trim().min(1).max(1000),
  topK: z.number().int().min(1).max(100).optional(),
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const { q, topK } = await parseJsonBody(request, searchBodySchema)
    return searchOfficeShelfDocuments(session, q, topK)
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only search over the caller's own org Archiv collection; scoped by session.organizationId",
    },
  }
)
