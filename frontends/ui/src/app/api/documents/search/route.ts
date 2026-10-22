/**
 * Document-centric semantic search over one shelf (`projectId`, or
 * `scope: office_shelf`): the best matching documents for `q`, each with its
 * snippet, page and score. Fail-open: a backend failure answers no hits. Thin
 * handler.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { searchDocumentsSchema } from '@/lib/documents/document-wire'
import { searchProjectDocuments } from '@/lib/documents/service'
import { shelfOf } from '@/lib/documents/shelf-scope'
import { searchOfficeShelfDocuments } from '@/lib/office-shelf/service'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { q, topK, ...selector } = await parseJsonBody(request, searchDocumentsSchema)
    const shelf = shelfOf(selector, request)
    return shelf.kind === 'project'
      ? searchProjectDocuments(session, shelf.projectId, q, topK)
      : searchOfficeShelfDocuments(session, q, topK)
  },
  {
    authz: {
      enforcedBy:
        'searchProjectDocuments -> listDocuments (requireProjectAccess project:view) | searchOfficeShelfDocuments (any member, scoped to session.organizationId)',
    },
  }
)
