/**
 * What one document is expected to cost to ingest, and whether that is above the
 * organisation's confirmation threshold.
 *
 * Server-side only, and deliberately narrow: the whole answer is
 * {@link DocumentIngestCost}, and the number it is compared against is resolved
 * in exactly one place (`./threshold`). Nothing here holds state, and nothing
 * here asks the backend for anything the ingest job did not already report — the
 * estimate is the one the job's cheap pre-read produced, read back from its
 * status.
 *
 * ## What the caller must do with it
 *
 * This slice only READS the estimate. Confirming means holding the ingest job
 * until a person answers and resuming it if they do — a later slice. Until then
 * the estimate is available as soon as the job has run its pre-read, and a
 * caller that finds `requiresConfirmation` true can say so but cannot yet stop
 * the spend.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { extractIngestJobId, readBackendJobFile } from '@/lib/documents/reconcile-status'
import { shouldConfirmIngest } from './contract'
import { resolveIngestCostThreshold } from './threshold'
import { parseBackendIngestCostReport, type DocumentIngestCost } from './types'

export type { DocumentIngestCost }

/**
 * Read the estimate the document's ingest job reported, or null.
 *
 * Null is "nothing to show": no job was dispatched (nothing has been priced), or
 * the backend did not report a cost for the file (it is not a PDF, or the
 * pre-read could not measure it — the report then carries `expectedUsd: null`,
 * which the threshold rule reads as "do not ask").
 */
async function readReportedEstimate(metadata: unknown, filename: string): Promise<DocumentIngestCost['estimate']> {
  const jobId = extractIngestJobId(metadata)
  if (!jobId) return null
  const file = await readBackendJobFile(jobId, filename)
  return file ? parseBackendIngestCostReport(file.ingest_cost) : null
}

/**
 * One document's ingest cost and its confirmation decision.
 *
 * Authorized as a read of the document itself (`getAccessibleDocument`), so a
 * caller learns nothing about a row it may not see. A backend that cannot be
 * reached leaves the estimate null rather than failing the request: "not yet
 * known" is a state the caller already renders.
 */
export async function readDocumentIngestCost(
  session: AuthorizedSession,
  documentId: string
): Promise<DocumentIngestCost> {
  const document = await getAccessibleDocument(session, documentId)
  const thresholdUsd = await resolveIngestCostThreshold(session.organizationId)
  const estimate = await readReportedEstimate(document.metadata, document.filename)
  return {
    estimate,
    thresholdUsd,
    requiresConfirmation: shouldConfirmIngest(estimate?.expectedUsd ?? null, thresholdUsd),
  }
}
