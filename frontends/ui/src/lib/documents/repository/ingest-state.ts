/** Stuck, transient and failed ingest documents. */

import 'server-only'
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { documentShelf } from '../shelf'
import { publishShelfChanged } from '../shelf-live'
import { bffJobQueue } from '@/lib/db/schema/bff-job-queue'
import { documents } from '@/lib/db/schema/documents'
import { notQuarantined } from './mutations'

/** A document left at `processing` with no live job behind it. */
export interface StuckProcessingDocument {
  id: string
  organizationId: string
  /** `dead` when its job failed every attempt, `null` when it has none (a row from before jobs, or a lost enqueue). */
  jobStatus: 'dead' | null
  lastError: string | null
}

/**
 * Documents at `processing` since before `before` whose job is gone or dead,
 * oldest first. Platform scope by nature: the caller is a sweep over every
 * organization, and acts on each row inside its own.
 *
 * A row whose job is still `queued` or `claimed` is left out in the query, so
 * the batch is always rows that need something done. So is a row in a folder
 * that went to the Papierkorb (ADR-0088): it is hidden and its chunks were
 * purged, and restoring the folder marks it `processing` for the restore's
 * job again; a job queued for it here would only parse or convert a document
 * nobody may see. Once restored, a row that job never reached (it died, or its
 * requester lost access) is found here like any other.
 */
export async function listStuckProcessingDocuments(
  before: Date,
  limit: number,
): Promise<StuckProcessingDocument[]> {
  const db = getDb()
  const rows = await withPlatformAccess('document sweep: finding rows left at processing without a live job', () =>
    db
      .select({
        id: documents.id,
        organizationId: documents.organizationId,
        jobStatus: bffJobQueue.status,
        lastError: bffJobQueue.lastError,
      })
      .from(documents)
      .leftJoin(
        bffJobQueue,
        sql`${bffJobQueue.jobId} = nullif(${documents.metadata}->>'bffJobId', '')::uuid`,
      )
      .where(
        and(
          eq(documents.status, 'processing'),
          lt(documents.updatedAt, before),
          or(isNull(bffJobQueue.jobId), eq(bffJobQueue.status, 'dead')),
          sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`,
        ),
      )
      .orderBy(asc(documents.updatedAt))
      .limit(limit),
  )
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    jobStatus: row.jobStatus === 'dead' ? 'dead' : null,
    lastError: row.lastError ?? null,
  }))
}

/** A failed document the transient-retry sweep may send back: its id, its organization, how often it was sent. */
export interface TransientFailureDocument {
  id: string
  organizationId: string
  attempts: number
}

/**
 * Failed documents whose failure the backend called `transient` (an interruption, a timeout, a download
 * or upstream error), sent fewer than `maxAttempts` times, and whose last attempt is older than its backoff:
 * `firstBackoffMinutes` after the first attempt, doubling with each further one. Oldest first, bounded.
 * Discovery across every organization, like {@link listStuckProcessingDocuments}; each row is retried
 * inside its own. A person's document only (`authored_by = 'user'`), with stored bytes, not in the bin.
 */
export async function listTransientFailures(
  now: Date,
  options: { maxAttempts: number; firstBackoffMinutes: number; maxAgeHours: number; limit: number },
): Promise<TransientFailureDocument[]> {
  const db = getDb()
  const attempts = sql`greatest(coalesce(${documents.ingestAttempts}, 1), 1)`
  const rows = await withPlatformAccess('document sweep: finding transient ingest failures to retry', () =>
    db
      .select({ id: documents.id, organizationId: documents.organizationId, attempts: documents.ingestAttempts })
      .from(documents)
      .where(
        and(
          eq(documents.status, 'failed'),
          eq(documents.ingestFailureCategory, 'transient'),
          eq(documents.authoredBy, 'user'),
          sql`${documents.storageKey} IS NOT NULL`,
          sql`coalesce(${documents.ingestAttempts}, 1) < ${options.maxAttempts}`,
          sql`${documents.updatedAt} < ${now.toISOString()}::timestamptz - make_interval(mins => ${options.firstBackoffMinutes} * power(2, ${attempts} - 1)::int)`,
          sql`${documents.updatedAt} > ${now.toISOString()}::timestamptz - make_interval(hours => ${options.maxAgeHours})`,
          sql`NOT EXISTS (SELECT 1 FROM project_folders f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL)`,
        ),
      )
      .orderBy(asc(documents.updatedAt))
      .limit(options.limit),
  )
  return rows.map((row) => ({ id: row.id, organizationId: row.organizationId, attempts: Number(row.attempts ?? 1) }))
}

/**
 * Persist an ingestion failure so status reads tell the truth. Without this a
 * document whose ingest dispatch never started would sit at 'uploaded' — which
 * the UI renders as a green "Ready" — forever (reconciliation only revisits
 * in-flight statuses, and there is no job id to reconcile against).
 *
 * A failure the BFF records itself (the dispatch did not start, the office
 * conversion or the IFC parse failed) carries no backend category, so it
 * clears the last one (migration 0134): a dispatch that never reached the
 * backend says nothing about the bytes, and an earlier `deterministic` left
 * standing would refuse the retry this failure deserves.
 */
export async function markDocumentIngestFailed(
  documentId: string,
  organizationId: string,
  errorMessage: string,
): Promise<void> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(documents)
      .set({ status: 'failed', errorMessage, ingestFailureCategory: null, ingestRetryable: null, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId), notQuarantined))
      .returning({ projectId: documents.projectId, scope: documents.scope }),
  )
  // The one door every hard failure goes through (a dispatch refused, an IFC
  // extraction that failed, a row stuck in processing): the badge turns red
  // for everyone reading the shelf, not only for a tab that happens to poll it.
  if (row) publishShelfChanged(organizationId, documentShelf(row))
}
