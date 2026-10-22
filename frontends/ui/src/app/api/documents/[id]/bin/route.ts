/**
 * Move one project document to the bin (ADR-0088, ADR-0131 rule 7): out of
 * every listing and out of retrieval, restorable with `POST …/restore` until
 * the purge date the answer names. No body. Thin handler;
 * `@/lib/projects/document-bin` decides.
 */

import { apiRoute } from '@/lib/api/handler'
import { moveDocumentToBin } from '@/lib/projects/document-bin'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => moveDocumentToBin(session, params.id, request),
  { authz: { enforcedBy: 'moveDocumentToBin (requireFolderWrite: project:documents:write + write on its folder)' } }
)
