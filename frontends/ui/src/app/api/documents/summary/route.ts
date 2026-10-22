/**
 * A shelf's summary (ADR-0102): counts per folder by read-state family and the
 * failed documents, for `?projectId=` or `?scope=office_shelf`, with the same
 * server filters as the listing. Thin handler; `@/lib/documents/shelf-summary`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { documentSummaryQuerySchema } from '@/lib/documents/document-wire'
import { summarizeOfficeShelfDocuments, summarizeProjectDocuments } from '@/lib/documents/shelf-summary'
import { shelfOf } from '@/lib/documents/shelf-scope'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { scope, projectId, authoredBy, includeArchived } = parseQuery(request, documentSummaryQuerySchema)
    const shelf = shelfOf({ scope, projectId }, request)
    const options = { authoredBy, includeArchived: includeArchived === 'true' }
    return shelf.kind === 'project'
      ? summarizeProjectDocuments(session, shelf.projectId, options)
      : summarizeOfficeShelfDocuments(session, options)
  },
  {
    authz: {
      enforcedBy:
        'summarizeProjectDocuments (requireProjectAccess project:view) | summarizeOfficeShelfDocuments (any member, scoped to session.organizationId)',
    },
  }
)
