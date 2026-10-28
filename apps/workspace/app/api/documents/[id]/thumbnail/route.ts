/**
 * Document thumbnail API — presign a browser-facing thumbnail URL
 * (null url signals no thumbnail available).
 * Thin handler; all logic lives in `@/lib/documents/document-delivery`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentThumbnail } from '@/lib/documents/document-delivery'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getDocumentThumbnail(session, params.id),
  { authz: { enforcedBy: 'getDocumentThumbnail -> getAccessibleDocument (project:view)' } }
)
