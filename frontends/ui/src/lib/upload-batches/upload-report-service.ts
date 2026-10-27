/**
 * The Eingangsbericht of a completed batch (`./upload-report`), computed at
 * the settle for the `upload.completed` row its uploader receives.
 *
 * Read as the uploader, the row's only recipient: their session is resolved
 * now (`resolvePinnedRequesterSession`, as the intake reading starts one), and
 * the project's documents come through the findings' own read
 * (`readProjectFindingsInput`), which is the Dateien listing: the same
 * `project:view` gate, folder hiding and held-upload rule. A document the
 * uploader may not see is in no count and no finding. The batch's documents
 * are its rows the uploader may see (`memberReader`), narrowed to those the
 * listing hands them.
 *
 * Bounded and fail-open. One read of the shelf (at most what the findings
 * read), a time limit on the whole, and any failure or overrun answers null:
 * the row is written without a report and the settle goes on. Never throws.
 */

import 'server-only'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { UploadBatch } from '@/lib/db/schema'
import { memberReader } from '@/lib/documents/document-reader'
import { listBatchDocuments } from './repository'
import { reportSaysSomething, uploadReport, type UploadReport } from './upload-report'

/** The settle waits this long for the report; past it the row goes out without one. */
export const UPLOAD_REPORT_TIMEOUT_MS = 4_000

async function computeUploadReport(batch: UploadBatch, projectId: string): Promise<UploadReport | null> {
  const session = await resolvePinnedRequesterSession({
    userId: batch.createdBy,
    email: null,
    organizationId: batch.organizationId,
  })
  if (!session) return null
  const rows = await listBatchDocuments(batch.organizationId, batch.id, memberReader(batch.createdBy))
  const batchIds = new Set(rows.map((row) => row.id))
  if (batchIds.size === 0) return null
  // Loaded on demand: the documents' service imports the settle, which imports this.
  const { readProjectFindingsInput } = await import('@/lib/documents/findings-service')
  const { documents, profile } = await readProjectFindingsInput(session, projectId)
  const batchDocuments = documents.filter((document) => batchIds.has(document.id))
  if (batchDocuments.length === 0) return null
  const summary = uploadReport(batchDocuments, documents, profile)
  return reportSaysSomething(summary) ? { projectId, ...summary } : null
}

/** What the batch brought its project, or null: not a project upload, nothing read, a failure, too slow. */
export async function uploadReportFor(batch: UploadBatch): Promise<UploadReport | null> {
  if (batch.scope !== 'project' || !batch.projectId) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[upload-batches] the report of batch ${batch.id} took too long; its row goes out without one`)
      resolve(null)
    }, UPLOAD_REPORT_TIMEOUT_MS)
  })
  const report = computeUploadReport(batch, batch.projectId).catch((error: unknown) => {
    console.warn(`[upload-batches] the report of batch ${batch.id} failed; its row goes out without one:`, error)
    return null
  })
  try {
    return await Promise.race([report, timeout])
  } finally {
    clearTimeout(timer)
  }
}
