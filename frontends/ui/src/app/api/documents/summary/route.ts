/**
 * Documents API — what Postgres can say about every document of a project's
 * shelf, counted per folder by read-state family, and its failed documents
 * (ADR-0102). The folder tiles and the folder brief of a Files workspace that
 * reads a folder level page by page fold their numbers from this.
 *
 * Takes the listing's two server filters (`authoredBy`, `includeArchived`), so
 * the counts are of the listing the reader is looking at.
 *
 * Thin handler; all logic lives in `@/lib/documents/shelf-summary`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { documentSummaryQuerySchema } from '@/lib/documents/document-wire'
import { summarizeProjectDocuments } from '@/lib/documents/shelf-summary'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { projectId, authoredBy, includeArchived } = parseQuery(request, documentSummaryQuerySchema)
    return summarizeProjectDocuments(session, projectId, { authoredBy, includeArchived: includeArchived === 'true' })
  },
  { authz: { enforcedBy: 'summarizeProjectDocuments (requireProjectAccess project:view)' } }
)
