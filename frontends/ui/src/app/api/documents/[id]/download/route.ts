/**
 * Document download API — presign a browser-facing download URL.
 * Thin handler; all logic lives in `@/lib/documents/document-delivery`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentDownload } from '@/lib/documents/document-delivery'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getDocumentDownload(session, params.id),
  { authz: { enforcedBy: 'getDocumentDownload -> getAccessibleDocument (project:view)' } }
)
