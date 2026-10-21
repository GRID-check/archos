/**
 * Documents API — document-centric semantic search over a project's corpus.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { searchDocumentsSchema } from '@/lib/documents/document-wire'
import { searchProjectDocuments } from '@/lib/documents/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { projectId, q, topK } = await parseJsonBody(request, searchDocumentsSchema)
    return searchProjectDocuments(session, projectId, q, topK)
  },
  {
    authz: {
      enforcedBy: 'searchProjectDocuments -> listDocuments (requireProjectAccess project:view)',
    },
  }
)
