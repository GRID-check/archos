/**
 * Re-ingesting one document, and cancelling an ingest that is running.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import { ConflictError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { documentStatusFacts } from './document-status'
import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'
import { INGEST_ALREADY_DONE, INGEST_NOT_ELIGIBLE, INGEST_RUNNING, INGEST_WOULD_FAIL_AGAIN } from './reingest-codes'
import { canRetry, contentHashChanged, CURRENT_INGEST_READER_VERSION, type RetryFacts } from './retry-policy'
import type { AuthorizedSession } from '@/lib/auth/types'
import { onDocumentsSettled } from '@/lib/upload-batches/settle'
import { cancelledResolution, describeBackendIngestState, extractIngestJobId } from './reconcile-status'
import { resolveDocumentFolderPath } from './folder-path'
import { setDocumentReconciledStatus } from './repository'
import { getAccessibleDocument } from './access'
import { type DispatchDocumentResult, dispatchDocument } from './document-dispatch'
import { BACKEND_FETCH_TIMEOUT_MS, type IngestPriority } from './ingest-dispatch'

export interface ReingestDocumentResult {
  id: string
  status: DispatchDocumentResult['status']
  jobId: string | null
}

/**
 * Re-dispatch a document to the backend ingest API, keeping its id.
 *
 * Three kinds of row are eligible, each for its own reason:
 *
 *  - failed, or stranded at the `uploaded` birth status: a plain retry.
 *  - in flight (`pending`, `processing`, …): only when the backend has LOST
 *    the job — see the branch below.
 *  - indexed (the `success` family, e.g. `completed`) and written by a person:
 *    a deliberate re-read of an unchanged file, to pick up a change to how
 *    files are READ (ADR-0071 taught Word and PowerPoint to read their
 *    pictures; nothing in the upload path would notice that). Safe because the
 *    backend replaces a version only once the new one has indexed
 *    (`_retire_previous_version`, `llamaindex/adapter.py`): the old chunks stay
 *    citable for the length of the job, and stay for good if it fails.
 *    An agent-authored row is not offered this: its index entry belongs to a
 *    published version, which only `ingestPublished` may dispatch.
 *
 * Every refusal is a 409 whose `details.code` says why (`./reingest-codes`),
 * so the client can tell "already running" and "already finished" from a
 * failure worth retrying.
 *
 * A failure is retried only when reading it again may come out differently
 * (`canRetry`, `./retry-policy`): a file that failed for a lasting reason with
 * the same bytes and the same reader is refused with `INGEST_WOULD_FAIL_AGAIN`,
 * which the client turns into "upload a new version". Decided on the failure
 * the backend reported, so a row healed from `processing` to `failed` here is
 * judged by the job that just failed, not by the row's earlier columns.
 */
export async function reingestDocument(
  session: AuthorizedSession,
  documentId: string,
  options: { priority?: IngestPriority } = {}
): Promise<ReingestDocumentResult> {
  const doc = await getAccessibleDocument(session, documentId, 'write')

  if (!doc.storageKey) throw new NotFoundError('File not available')

  const variant = documentStatusFacts(doc.status)?.variant
  const isIndexed = variant === 'success'
  const isRetryable = variant === 'destructive' || doc.status === 'uploaded'
  const isInFlight = IN_FLIGHT_DOCUMENT_STATUSES.has(doc.status)

  if (isIndexed && doc.authoredBy !== 'user') {
    throw new ConflictError('Only documents a person uploaded can be re-read once indexed', {
      status: doc.status,
      code: INGEST_NOT_ELIGIBLE,
    })
  }
  if (!isIndexed && !isRetryable && !isInFlight) {
    throw new ConflictError('This document is not in a state that can be re-ingested', {
      status: doc.status,
      code: INGEST_NOT_ELIGIBLE,
    })
  }

  // The failure a retry would answer: the row's own, or (below) the one the
  // backend just reported for a row that looked in flight. Null when the retry
  // answers no failure at all (an indexed re-read, a lost in-flight job).
  let failure: RetryFacts | null = isRetryable
    ? {
        status: doc.status,
        ingestFailureCategory: doc.ingestFailureCategory,
        ingestRetryable: doc.ingestRetryable,
        ingestReaderVersion: doc.ingestReaderVersion,
      }
    : null

  if (isInFlight) {
    // In flight: retry only what the backend has LOST. A row can sit at
    // `processing` forever — a backend restart wipes the in-memory job
    // registry, a detached IFC extraction dies with the process — while the
    // old guard answered every one of those with 409 and the user's only way
    // out was delete + re-upload under a NEW id, breaking every citation,
    // chat subject and assignment pointing at the old one. Retrying keeps the
    // id, so nothing pointing at the document breaks.
    //
    // The check is live backend state, not a timer: a row is retryable when
    // the backend knows neither a job nor a file for it. A job that is
    // genuinely running refuses with 409 rather than doubling VLM work.
    const knowledge = await describeBackendIngestState({
      metadata: doc.metadata,
      collectionName: doc.collectionName,
      filename: doc.filename,
      authoredBy: doc.authoredBy,
      publishedVersionId: doc.publishedVersionId,
    })
    if (knowledge.state === 'in-progress') {
      throw new ConflictError('Ingestion is still running for this document', {
        status: doc.status,
        code: INGEST_RUNNING,
      })
    }
    if (knowledge.state === 'unreachable') {
      throw new UpstreamError('The ingestion backend could not be reached, so a retry cannot be verified as safe')
    }
    if (knowledge.state === 'terminal') {
      // Finished behind the row's back (no listing read reconciled it yet).
      // Heal the row either way. A success is not re-dispatched: the reader
      // clicked "retry" on what looked stuck, and it is done. A failure is
      // what they were retrying, so it goes on to the dispatch below.
      const moved = await setDocumentReconciledStatus(doc.id, session.organizationId, knowledge.resolution, {
        status: doc.status,
        jobId: extractIngestJobId(doc.metadata),
      })
      if (knowledge.resolution.status !== 'failed') {
        // Came to rest here rather than on a listing read: settle it as
        // reconciliation would, or a quarantine is never audited and its
        // reviewers never told. Only if this write moved the row: a listing
        // read that got there first has settled it. Never throws.
        if (moved) {
          await onDocumentsSettled(session.organizationId, [{ id: doc.id, status: knowledge.resolution.status }])
        }
        throw new ConflictError(`Ingestion already ${knowledge.resolution.status} for this document`, {
          status: knowledge.resolution.status,
          code: INGEST_ALREADY_DONE,
        })
      }
      failure = {
        status: knowledge.resolution.status,
        ingestFailureCategory: knowledge.resolution.failure?.category ?? null,
        ingestRetryable: knowledge.resolution.failure?.retryable ?? null,
        ingestReaderVersion: knowledge.resolution.failure?.readerVersion ?? null,
      }
    }
  }

  if (
    failure &&
    !canRetry(failure, {
      currentReaderVersion: CURRENT_INGEST_READER_VERSION,
      contentHashChanged: contentHashChanged(doc),
    })
  ) {
    throw new ConflictError('Reading this file again would fail the same way', {
      status: failure.status,
      code: INGEST_WOULD_FAIL_AGAIN,
    })
  }

  // The bucket the object is ACTUALLY in — `doc.storageBucket`, not the bucket
  // a new upload would go to. Both presigned URLs the dispatch mints name it:
  // the download the backend reads from, and the thumbnail slot it writes back
  // to. Omitting it defaulted both to the shared bucket, so retrying a
  // per-organization document presigned a GET for an object that is not there
  // (the retry can never succeed) and a PUT into the shared bucket for a
  // thumbnail every read path then looks for in the tenant bucket.
  // A failed IFC document is retried by re-EXTRACTING it, not by re-dispatching
  // its bytes: the raw model was never what ingestion consumed, so handing the
  // STEP file to the ingestor here would "succeed" into a collection full of
  // geometry noise — a green status on a model still unopenable. That is
  // `dispatchDocument`'s single branch, shared with every upload path.
  const { jobId, status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
    folderPath: await resolveDocumentFolderPath(doc, session.organizationId),
    priority: options.priority,
  })
  return { id: doc.id, status, jobId }
}

/**
 * What a cancel did, as `POST /api/documents/{id}/cancel` reports it.
 *
 *  - `cancelled` — a live job was stopped, and this call settled the row
 *    `cancelled` (see {@link cancelDocumentIngest}).
 *  - `finished` — the durable queue held no live row: the job had already run
 *    to an end, and the next listing read reconciles the row to its real
 *    outcome. Not a failure; there was simply nothing to stop.
 *  - `unavailable` — nothing this tier can stop: the durable ingest queue is
 *    off (the job runs in a process the BFF cannot reach), or the row carries
 *    no job id (work the BFF itself owns, `processing`).
 */
export type CancelIngestOutcome = 'cancelled' | 'finished' | 'unavailable'

export interface CancelIngestResult {
  id: string
  result: CancelIngestOutcome
}

/**
 * One `POST /v1/documents/{jobId}/cancel`, bounded.
 *
 * A transport failure or an answer this build does not understand is an
 * {@link UpstreamError}, never a quiet `finished`: "we could not ask whether it
 * stopped" must not read to the reader as "there was nothing to stop".
 */
async function requestIngestCancel(jobId: string, organizationId: string): Promise<CancelIngestOutcome> {
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/documents/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      // Forward the org id, as the dispatch does: the backend resolves the
      // organization's queue from it.
      headers: { 'x-organization-id': organizationId },
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError(
      'The ingestion backend could not be reached to stop this job',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok) throw new UpstreamError(`Stopping this job returned ${response.status}`)
  const body: unknown = await response.json().catch(() => null)
  const result =
    typeof body === 'object' && body !== null ? (body as { result?: unknown }).result : null
  if (result === 'cancelled' || result === 'finished' || result === 'unavailable') return result
  throw new UpstreamError('Stopping this job returned an unexpected shape')
}

/**
 * Stop a running ingest for one document: a person's upload still being read,
 * or a queued one that has not started.
 *
 * The stop is the durable queue's (`POST /v1/ingest`'s job row), so it is safe
 * to repeat: a queued job is never claimed, a running worker stops at its next
 * ownership check — before it reads or writes anything — and the backend
 * settles the job `cancelled` either way. Nothing is half-indexed: a job
 * stopped between reads leaves no chunks, and a job that finalized in the same
 * instant as the stop is healed back by the reconcile's cancelled re-check
 * (`./reconcile-status`).
 *
 * The row is settled `cancelled` HERE, on a confirmed stop, rather than left to
 * the next listing read: the surface the person is looking at must stop saying
 * the file is being read. A row the write did not move (a concurrent read got
 * there first) settles nothing, exactly as reconciliation does.
 *
 * Authorization is {@link getAccessibleDocument} with `write`, the same gate
 * every other mutation of a document passes.
 */
export async function cancelDocumentIngest(
  session: AuthorizedSession,
  documentId: string
): Promise<CancelIngestResult> {
  const doc = await getAccessibleDocument(session, documentId, 'write')

  // Nothing to stop on a row that has come to rest. The control is offered only
  // for an in-flight row, so this is the race where the job ended between the
  // render and the click: reported as `finished`, which the client shows as
  // "already done", never as a stop that did not happen.
  if (!IN_FLIGHT_DOCUMENT_STATUSES.has(doc.status)) {
    return { id: doc.id, result: 'finished' }
  }

  const jobId = extractIngestJobId(doc.metadata)
  if (!jobId) {
    // In flight with no job id: the work runs inside the BFF (`processing` — an
    // IFC extraction or an office rendition) or predates the job id being
    // recorded. Neither has a durable queue row for this tier to stop.
    return { id: doc.id, result: 'unavailable' }
  }

  const result = await requestIngestCancel(jobId, session.organizationId)
  if (result === 'cancelled') {
    const resolution = cancelledResolution()
    const moved = await setDocumentReconciledStatus(doc.id, session.organizationId, resolution, {
      status: doc.status,
      jobId,
    })
    if (moved) {
      // Settle the upload batch and audit as a listing read would: a cancelled
      // row still has to tell its batch it came to rest. Never throws.
      await onDocumentsSettled(session.organizationId, [{ id: doc.id, status: 'cancelled' }])
    }
  }
  return { id: doc.id, result }
}
