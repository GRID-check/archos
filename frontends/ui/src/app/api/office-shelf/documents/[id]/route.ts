/**
 * Archiv document item API — delete an Archiv document (purges SeaweedFS, the RAG
 * chunks, and the DB row). Thin handler; authorization (`org:office_shelf:manage`)
 * lives in `@/lib/office-shelf/service` (ADR-0024).
 *
 * Read/preview/download/reingest/tags reuse the shared, scope-aware item routes
 * under `/api/documents/[id]/*` — no per-scope duplication.
 */

import { apiRoute } from '@/lib/api/handler'
import { deleteOfficeShelfDocument } from '@/lib/office-shelf/service'

export const DELETE = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    await deleteOfficeShelfDocument(session, params.id, request)
    return null
  },
  { authz: { enforcedBy: 'deleteOfficeShelfDocument (canManageOfficeShelf)' } }
)
