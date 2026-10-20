/**
 * Archiv API — list the organization's Archiv documents, one keyset page at a
 * time (`?cursor=` from the previous page's `nextCursor`), with the same filters
 * and the same rows as a project's `GET /api/documents`: `?includeArchived=true`
 * and `?authoredBy=agent|user` (`@/lib/documents/list-query`), each row through
 * `toDocumentWireRows` — folder, origin path, author, lifecycle and version
 * state included (ADR-0078). The level parameters (`folderId`, `sort`, `dir`,
 * `q`, `state`, `limit`) read one folder level in the reader's order instead
 * of draining the Archiv (ADR-0102).
 * Thin handler; all logic lives in `@/lib/office-shelf/service` (ADR-0024).
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listOfficeShelf } from '@/lib/office-shelf/service'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { documentListFilterSchema, documentListOptions } from '@/lib/documents/list-query'

export const GET = apiRoute(
  async ({ session, request }) => {
    const filter = parseQuery(request, documentListFilterSchema)
    const { documents, ...page } = await listOfficeShelf(session, documentListOptions(filter))
    return { ...page, documents: await toDocumentWireRows(session.organizationId, documents) }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'the Archiv is org-wide shared knowledge; listOfficeShelf scopes to session.organizationId and reports canManage for the UI',
    },
  }
)
