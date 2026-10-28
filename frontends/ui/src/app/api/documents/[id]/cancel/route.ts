/**
 * Document cancel API — stop a running or queued ingestion for one document.
 * Thin handler; all logic (access check, in-flight guard, the durable-queue
 * call, settling the row `cancelled`) lives in `@/lib/documents/reingest`.
 */

import { apiRoute } from '@/lib/api/handler'
import { cancelDocumentIngest } from '@/lib/documents/reingest'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => cancelDocumentIngest(session, params.id),
  { authz: { enforcedBy: 'cancelDocumentIngest -> getAccessibleDocument (project:documents:write)' } }
)
