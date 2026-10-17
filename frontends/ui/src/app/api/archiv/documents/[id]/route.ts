/**
 * Archiv document item API — delete an Archiv document (purges SeaweedFS, the RAG
 * chunks, and the DB row). Thin handler; authorization (`org:archiv:manage`)
 * lives in `@/lib/archiv/service` (ADR-0024).
 *
 * Read/preview/download/reingest/tags reuse the shared, scope-aware item routes
 * under `/api/documents/[id]/*` — no per-scope duplication.
 */

import { apiRoute } from '@/lib/api/handler'
import { deleteArchivDocument } from '@/lib/archiv/service'

export const DELETE = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    await deleteArchivDocument(session, params.id, request)
    return null
  },
  { authz: { enforcedBy: 'deleteArchivDocument (canManageArchiv)' } }
)
