/**
 * Archiv API — what Postgres can say about every document of the
 * organization's Archiv, counted per folder by read-state family, and its
 * failed documents (ADR-0102): the Archiv's half of
 * `GET /api/documents/summary`, with the same filters and the same body.
 *
 * Thin handler; all logic lives in `@/lib/documents/shelf-summary`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { documentSummaryFilterSchema } from '@/lib/documents/list-query'
import { summarizeOfficeShelfDocuments } from '@/lib/documents/shelf-summary'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { authoredBy, includeArchived } = parseQuery(request, documentSummaryFilterSchema)
    return summarizeOfficeShelfDocuments(session, { authoredBy, includeArchived: includeArchived === 'true' })
  },
  {
    authz: {
      sessionOnly: true,
      why: 'the Archiv is org-wide shared knowledge; summarizeOfficeShelfDocuments scopes to session.organizationId and counts the rows listOfficeShelf already shows any member',
    },
  }
)
