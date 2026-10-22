/**
 * Document item API — read one document as a listing row (GET), rename a
 * document (PATCH) and delete a document permanently (DELETE). Thin handlers;
 * authorization and all logic live in `@/lib/documents/service` and
 * `@/lib/documents/listed-document`.
 *
 * GET is scope-aware like PATCH: a project document or an Archiv document, as
 * the row its shelf's listing would carry (`toDocumentWireRows`), for a link to
 * a document the paged Files level has not loaded (ADR-0102).
 *
 * PATCH is SCOPE-AWARE, like the sibling item routes (download/preview/status/
 * reingest/tags) under this `[id]` folder: it renames a project document and an
 * org-wide Archiv document alike, because `renameDocument` resolves which
 * permission applies from the row itself.
 *
 * DELETE is scope-aware too: `deleteDocument` erases a project document behind
 * the folder's write access and an office shelf document behind
 * `org:office_shelf:manage` (`deleteOfficeShelfDocument`).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { deleteDocument, renameDocument } from '@/lib/documents/service'
import { getListedDocument } from '@/lib/documents/listed-document'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { renameDocumentSchema } from '@/lib/documents/document-wire'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const listed = await getListedDocument(session, params.id)
    const [document] = await toDocumentWireRows(session.organizationId, [listed])
    return { document }
  },
  {
    authz: {
      enforcedBy: 'getListedDocument -> getAccessibleDocument (project:view | any member of the Archiv organization)',
    },
  }
)

/**
 * `null` is a real value here, not an omission: it CLEARS the rename and
 * restores the file's own name, which is what the preview's "restore original
 * name" action sends. The bounds only guard request shape — the service
 * re-validates with `validateDocumentName`, which is also what the dialog uses,
 * so the rule is stated once and enforced on both sides.
 */
export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { displayName } = await parseJsonBody(request, renameDocumentSchema)
    return renameDocument(session, params.id, displayName, request)
  },
  { authz: { enforcedBy: 'renameDocument -> getAccessibleDocument (project:documents:write | org:office_shelf:manage)' } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    await deleteDocument(session, params.id, request)
    return null
  },
  { authz: { enforcedBy: 'deleteDocument (requireFolderWrite project:documents:write | deleteOfficeShelfDocument canManageOfficeShelf)' } }
)
