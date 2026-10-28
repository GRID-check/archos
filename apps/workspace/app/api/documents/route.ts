/**
 * Documents API — list one shelf's documents, one keyset page at a time
 * (`?cursor=` from the previous page's `nextCursor`, `null` on the last page).
 * The shelf is `?projectId=` or `?scope=office_shelf` (`@/lib/documents/shelf-scope`);
 * the office shelf's page also says `collectionName` and `canManage`.
 *
 * Every request is a bounded page: one folder level (`folderId`) or the whole
 * shelf, in the reader's order, `limit` a page (default 100, at most 500;
 * ADR-0102, ADR-0131, `@/lib/documents/list-query`).
 *
 * Thin handler; the logic lives in `@/lib/documents/document-listing` and
 * `@/lib/office-shelf/service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listDocumentsPage } from '@/lib/documents/document-listing'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { documentListOptions, documentListQuerySchema } from '@/lib/documents/list-query'
import { shelfOf } from '@/lib/documents/shelf-scope'
import { listOfficeShelf } from '@/lib/office-shelf/service'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { scope, projectId, ...filter } = parseQuery(request, documentListQuerySchema)
    const shelf = shelfOf({ scope, projectId }, request)
    const options = documentListOptions(filter)
    const { documents, ...page } =
      shelf.kind === 'project'
        ? await listDocumentsPage(session, shelf.projectId, options)
        : await listOfficeShelf(session, options)
    return { ...page, documents: await toDocumentWireRows(session.organizationId, documents) }
  },
  {
    authz: {
      enforcedBy:
        'listDocumentsPage (requireProjectAccess project:view) | listOfficeShelf (any member: the office shelf is org-wide shared knowledge, scoped to session.organizationId)',
    },
  }
)
