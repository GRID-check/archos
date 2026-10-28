/**
 * Document preview API — presign a browser-facing inline preview URL
 * (415 for non-previewable content types). An office document is previewed
 * through its PDF rendition (`rendition: true`, 502 `RENDITION_FAILED` when the
 * conversion fails; ADR-0070).
 * Thin handler; all logic lives in `@/lib/documents/document-delivery`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentPreview } from '@/lib/documents/document-delivery'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getDocumentPreview(session, params.id),
  { authz: { enforcedBy: 'getDocumentPreview -> getAccessibleDocument (project:view)' } }
)
