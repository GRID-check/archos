/**
 * Which folder a document is filed in — a project document's or an Archiv
 * document's (ADR-0078).
 *
 * Its own route rather than a field on `PATCH /api/documents/{id}`: that one
 * renames and tags, and a filing move needs the destination check (a folder of
 * the document's OWN shelf and tenant) and the backend path mirror. The logic and
 * the authz live in `@/lib/documents/move-to-folder`: the document's row says
 * which shelf it is on, and that shelf says who may move it.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { moveDocumentSchema } from '@/lib/documents/document-wire'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'

type Params = { id: string }

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { folderId, withTracedSketches } = await parseJsonBody(request, moveDocumentSchema)
    const result = await moveDocumentToFolder({ documentId: params.id, folderId, withTracedSketches }, session)
    if (!result.ok) throw new BadRequestError(result.error, result.reason ? { reason: result.reason, ...result.details } : undefined)
    // `pending`: moved across a restriction and not yet placed in its new collection; searchable nowhere until the sweep places it.
    return { ...result.document, pending: result.pending ?? false }
  },
  {
    authz: {
      enforcedBy:
        'moveDocumentToFolder (org scope; requireProjectAccess project:documents:write for a project document, canManageOfficeShelf for an Archiv document)',
    },
  }
)
