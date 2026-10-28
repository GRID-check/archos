/**
 * Restore one document from the bin (ADR-0088, ADR-0131 rule 7): filed again
 * where it came from and read into the index again. No body. Thin handler;
 * `@/lib/projects/document-bin` decides.
 */

import { apiRoute } from '@/lib/api/handler'
import { restoreDocumentFromBin } from '@/lib/projects/document-bin'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => restoreDocumentFromBin(session, params.id, request),
  { authz: { enforcedBy: 'restoreDocumentFromBin -> restoreFolderFromBin (document write + write on the folder)' } }
)
