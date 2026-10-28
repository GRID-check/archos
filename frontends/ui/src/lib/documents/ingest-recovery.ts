/**
 * Recovering documents whose ingest failed or stalled: the org-wide failed retry, the stuck
 * redispatch and the transient retry.
 */

import 'server-only'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { INGEST_ALREADY_DONE, INGEST_NOT_ELIGIBLE, INGEST_RUNNING, INGEST_WOULD_FAIL_AGAIN } from './reingest-codes'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolveDocumentFolderPath } from './folder-path'
import { collectionFileRef } from './collection-file-ref'
import { findDocumentInOrg, markDocumentIngestFailed, listFailedDocumentPageInOrg } from './repository'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { emptyCounts, recordJobFailure, requesterOf, type JobCounts, type JobSliceResult, type ReingestFailedPayload } from '@/lib/jobs-queue/types'
import { internalRead } from './document-reader'
import { dispatchDocument } from './document-dispatch'
import { INGEST_DISPATCH_FAILED_MESSAGE } from './ingest-dispatch'
import { REINDEX_CONCURRENCY, forEachBounded } from './reindex'
import { reingestDocument } from './reingest'

export interface ReingestFailedOrgResult {
  /** The job doing the work, on the `bff-jobs` pool (ADR-0081). */
  jobId: string
}

/** Failed documents one rescan slice sends back; see {@link REINDEX_SLICE_DOCUMENTS}. */
export const REINGEST_SLICE_DOCUMENTS = 25

function reingestRefusalCode(error: unknown): string | null {
  if (error instanceof ConflictError) {
    const details = error.details as { code?: unknown } | undefined
    return typeof details?.code === 'string' ? details.code : null
  }
  return null
}

/**
 * Re-dispatch every failed ingestion in the organization: authorize, then hand
 * the walk to a job.
 *
 * The rescan behind "Rescan failed ingestions" in Organization > Enterprise:
 * all files that were stored but could never be read (`failed`/`error`, plus
 * rows stranded at the `uploaded` birth status) go back through the ingest
 * pipeline under their own ids, so citations, chat subjects and assignments
 * pointing at them keep working.
 *
 * Like the reindex, the walk runs as a `bff-jobs` job (`reingest_failed`,
 * bulk), answered 202 with the job id. It pages through the failed set with a
 * keyset, so rows that stay failed cannot starve the rows behind them and the
 * job's whole state is one position. Each id still goes through
 * `reingestDocument`, so per-document access checks and the status guards stay
 * in exactly one place. Rows that are not retryable (still running, already
 * finished behind the row's back, not eligible, or no longer visible to the
 * requester) count as `skipped`, never as failures - and a dispatch that yields
 * no job resolves as `failed` rather than `queued`, because `dispatchIngest`
 * marks the row failed itself in that case. One document's failure never
 * abandons the rest.
 *
 * The rescan itself is audited (`org.documents.reingested`) with its outcome
 * when the job ends, because it is an organization-wide mutating admin action.
 */
export async function reingestFailedOrgDocuments(
  session: AuthorizedSession
): Promise<ReingestFailedOrgResult> {
  const open = await findOpenJobId({
    kind: 'reingest_failed',
    organizationId: session.organizationId,
    matching: {},
  })
  if (open) return { jobId: open }

  const payload: ReingestFailedPayload = {
    requester: requesterOf(session),
    cursor: null,
    counts: emptyCounts(),
  }
  const { jobId } = await enqueueJob({
    kind: 'reingest_failed',
    organizationId: session.organizationId,
    payload,
  })
  return { jobId }
}

/** How one failed document's retry came out. */
async function retryFailedDocument(
  session: AuthorizedSession,
  id: string
): Promise<'queued' | 'skipped' | 'failed'> {
  try {
    const outcome = await reingestDocument(session, id, { priority: 'bulk' })
    // No job id means the dispatch recorded the failure itself: the retry
    // went wrong, it did not queue.
    return outcome.status === 'failed' ? 'failed' : 'queued'
  } catch (error) {
    const code = reingestRefusalCode(error)
    if (
      code === INGEST_RUNNING ||
      code === INGEST_ALREADY_DONE ||
      code === INGEST_NOT_ELIGIBLE ||
      code === INGEST_WOULD_FAIL_AGAIN
    ) {
      return 'skipped'
    }
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return 'skipped'
    return 'failed'
  }
}

/**
 * One slice of a `reingest_failed` job: the next page of the failed set, sent
 * back through ingestion, and the position to resume from. The audit event is
 * written by the slice that finds the end of the set.
 */
export async function runReingestFailedSlice(
  session: AuthorizedSession,
  payload: ReingestFailedPayload
): Promise<JobSliceResult<ReingestFailedPayload>> {
  // The route's own gate, asked again: the job may have waited, and the walk
  // spans slices. `session` is the requester's rights today (`handlers.ts`), so a
  // person who lost `org:settings:manage` since they clicked ends the rescan here.
  if (!hasPermission(session, ORG_PERMISSIONS.settingsManage)) {
    console.warn(`[reingest] ${session.userId} no longer holds ${ORG_PERMISSIONS.settingsManage}; stopping the rescan`)
    return { done: true, payload }
  }

  const { ids, nextCursor } = await listFailedDocumentPageInOrg(session.organizationId, {
    limit: REINGEST_SLICE_DOCUMENTS,
    cursor: payload.cursor,
  })

  const counts: JobCounts = { ...payload.counts, failedNames: [...payload.counts.failedNames] }
  await forEachBounded(ids, REINDEX_CONCURRENCY, async (id) => {
    const outcome = await retryFailedDocument(session, id)
    if (outcome === 'failed') recordJobFailure(counts, id)
    else counts[outcome] += 1
  })

  const next = { ...payload, cursor: nextCursor, counts }
  if (nextCursor) return { done: false, payload: next }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.documents.reingested',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: {
      total: counts.queued + counts.skipped + counts.failed,
      queued: counts.queued,
      skipped: counts.skipped,
      failed: counts.failed,
      truncated: false,
    },
  })
  return { done: true, payload: next }
}

/** How the sweep's retry of one stranded document came out. */
export type StuckDocumentOutcome = 'requeued' | 'failed' | 'gone'

/**
 * Give a document left at `processing` with no live job a new one, or say
 * plainly that it cannot have one.
 *
 * The sweep's door (`./stuck-processing`), and the system's own act: no person
 * is asking, so no session and no permission check; what the row says is all
 * this believes. It goes through {@link dispatchDocument}, so a model is parsed
 * again and an office file converted again by the same code a first upload
 * runs, the machine-authored guard included. A row there is nothing to rebuild
 * from (no stored bytes, not a person's document) is failed with the reason
 * the dispatcher gives for a failed start, because a row left at `processing`
 * would be found by every later sweep for good.
 */
export async function redispatchStuckDocument(
  organizationId: string,
  documentId: string
): Promise<StuckDocumentOutcome> {
  const doc = await findDocumentInOrg(documentId, organizationId, internalRead('ingest'))
  // Gone, or moved on since the sweep read it.
  if (!doc || doc.status !== 'processing') return 'gone'

  if (!doc.storageKey || doc.authoredBy !== 'user' || !collectionFileRef(doc)) {
    await markDocumentIngestFailed(doc.id, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
    return 'failed'
  }
  const { status } = await dispatchDocument({
    organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
    folderPath: await resolveDocumentFolderPath(doc, organizationId),
    // Recovery is nobody's upload: it yields to the people who are waiting.
    priority: 'bulk',
  })
  return status === 'failed' ? 'failed' : 'requeued'
}

/** How the transient-retry sweep's retry of one failed document came out. */
export type TransientRetryOutcome = 'requeued' | 'failed' | 'gone'

/**
 * Send a document whose read failed for a passing reason (`transient`) back through ingestion.
 *
 * The sweep's door (`./transient-retry`), and the system's own act like {@link redispatchStuckDocument}:
 * no person is asking, so no session; what the row says is all this believes, and it is read again
 * here because the sweep's list may be stale. At `bulk` priority, so a retry yields to people's uploads.
 */
export async function retryTransientFailure(
  organizationId: string,
  documentId: string
): Promise<TransientRetryOutcome> {
  const doc = await findDocumentInOrg(documentId, organizationId, internalRead('ingest'))
  if (!doc || doc.status !== 'failed' || doc.ingestFailureCategory !== 'transient') return 'gone'
  if (!doc.storageKey || doc.authoredBy !== 'user' || !collectionFileRef(doc)) return 'gone'
  const { status } = await dispatchDocument({
    organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
    folderPath: await resolveDocumentFolderPath(doc, organizationId),
    priority: 'bulk',
  })
  return status === 'failed' ? 'failed' : 'requeued'
}
