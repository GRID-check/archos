/**
 * Ingest cost API — what one document is expected to cost to ingest, the
 * organisation's confirmation threshold, and whether the estimate crosses it.
 *
 * Thin handler; all logic lives in `@/lib/ingest-cost/service`. A read, so it is
 * gated on the document's own reader: `getAccessibleDocument` resolves the
 * permission from the row's shelf (project / Archiv / session attachment) and,
 * for a held file, from the quarantine-review rule (ADR-0086).
 */

import { apiRoute } from '@/lib/api/handler'
import { readDocumentIngestCost } from '@/lib/ingest-cost/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => readDocumentIngestCost(session, params.id),
  { authz: { enforcedBy: 'readDocumentIngestCost -> getAccessibleDocument (scope permission, read)' } }
)
