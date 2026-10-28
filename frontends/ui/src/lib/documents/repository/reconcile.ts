/** Status reconciliation against the ingest job, and screening release. */

import 'server-only'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbTransaction } from '@/lib/db/executor'
import { withTenant } from '@/lib/db/tenant-context'
import { type DocumentStatus } from '../document-status'
import { documentQuarantineDecisions } from '@/lib/db/schema/document-quarantine-decisions'
import { documentVersions } from '@/lib/db/schema/document-versions'
import { documents } from '@/lib/db/schema/documents'
import type { DocumentScreeningOutcome } from '@/lib/db/schema/documents'
import { auditedQuarantineReasons, storedQuarantineVerdictOf, type StoredQuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { heldAtRest } from '../visibility'
import { verdictPasses } from '../document-reader'
import { type IngestFailureFacts } from '../retry-policy'

/** What a reconciling read saw: the row's status, and the dispatch (ingest job) it resolved. */
export interface ReconciledFrom {
  status: string
  jobId: string | null
}

/** The row still carries the dispatch the read resolved: that job, or none. */
const sameDispatch = (jobId: string | null): SQL =>
  jobId
    ? sql`${documents.metadata} ->> 'ingestJobId' = ${jobId}`
    : sql`(${documents.metadata} ->> 'ingestJobId') IS NULL`

/** The digest the dispatch of the job being reconciled recorded, or the row's earlier one. */
const screenedHashOfDispatch = sql<string | null>`coalesce(${documents.metadata} ->> 'ingestContentHash', ${documents.screenedHash})`

/** The digest the dispatch of the job being reconciled recorded, and nothing else. */
export const dispatchedHash = sql<string | null>`${documents.metadata} ->> 'ingestContentHash'`

/**
 * A verdict recorded on the versions that hold the bytes it judged (migration
 * 0131, ADR-0086): the one writer of `document_versions.screened_hash`, called
 * only inside the transaction that records the item's verdict, so the item and
 * its versions never disagree about the same bytes.
 *
 * `document_versions.screened_hash` is what keeps an earlier upload readable
 * once a re-upload replaces it: the item's own `screened_hash` names the
 * current bytes and is reset by the replace. A pass sets it on every version of
 * this document holding `judgedHash`; a verdict that holds those bytes
 * (a quarantine) clears it, so the latest verdict about the bytes is the one on
 * record. No judged digest (a dispatch from before migration 0123 with nothing
 * on the item either) records nothing, and those versions stay refused.
 */
async function recordVersionVerdict(
  tx: DbTransaction,
  documentId: string,
  organizationId: string,
  verdict: { judgedHash: string | null; passed: boolean },
): Promise<void> {
  if (!verdict.judgedHash) return
  await tx
    .update(documentVersions)
    .set({ screenedHash: verdict.passed ? verdict.judgedHash : null })
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
        eq(documentVersions.contentHash, verdict.judgedHash),
      ),
    )
}

/**
 * Persist a reconciled ingestion status.
 *
 * Lives here rather than in `reconcile-status.ts` because a repository is the
 * only module that queries for this domain — the reconciler decides WHAT the
 * status should be, and this writes it.
 *
 * Guarded on what the caller read (`from`): the status AND the dispatch.
 * Returns whether this call moved the row. Reconciliation runs on reads, so two
 * reads (or a read and the re-ingest heal) can resolve the same in-flight row
 * at once, and only the one whose write lands may settle it. The status alone
 * is not enough: a release between two reads puts the row back in flight under
 * a NEW job, and a read that resolved the old one would write the old verdict
 * over it. A write keyed on the job lands only on the dispatch it is about.
 *
 * A quarantine is the content gate's decision (ADR-0086), and the same
 * transaction records it in `document_quarantine_decisions`, keyed on the
 * dispatch, for the audit trail: a moved row and its decision exist together
 * or not at all, and one job is one decision. Its verdict is written to
 * `documents.quarantine` with the status (migration 0148, ADR-0113), and every
 * other status writes NULL there: only a quarantined row carries one (CHECK).
 * `quarantine` is the job's typed verdict; a resolution without it (a job from
 * before the field) is read through `storedQuarantineVerdictOf`, the one
 * reader of the legacy message.
 *
 * `failure` is what the job said about the file (migration 0134): its failure
 * category, whether the same bytes may read again, and the reader that read
 * it, written with the status they explain, so the retry rule never reads one
 * outcome's category beside another outcome's status. Absent (a row going
 * back to `pending`) leaves all three as they are.
 */
export async function setDocumentReconciledStatus(
  documentId: string,
  organizationId: string,
  resolution: {
    status: DocumentStatus
    errorMessage: string | null
    screeningOutcome?: DocumentScreeningOutcome
    /** The job's typed verdict (ADR-0113); read only for a `quarantined` status. */
    quarantine?: StoredQuarantineVerdict | null
    failure?: IngestFailureFacts
  },
  from: ReconciledFrom,
): Promise<boolean> {
  const { failure } = resolution
  const verdict = resolution.status === 'quarantined' ? storedQuarantineVerdictOf(resolution) : null
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const [moved] = await tx
        .update(documents)
        .set({
          status: resolution.status,
          errorMessage: resolution.errorMessage,
          quarantine: verdict,
          // Only when the job said something (ADR-0086): an unscreened job must
          // not erase a reviewer's `released`.
          ...(resolution.screeningOutcome ? { screeningOutcome: resolution.screeningOutcome } : {}),
          // A job that read its bytes to the end vouches for THOSE bytes
          // (migration 0123): the digest its dispatch recorded, never the row's
          // current one, which a version swap may have moved since. A job
          // dispatched before 0122 recorded none and keeps the backfilled value.
          ...(resolution.status === 'completed' ? { screenedHash: screenedHashOfDispatch } : {}),
          ...(failure
            ? {
                ingestFailureCategory: failure.category,
                ingestRetryable: failure.retryable,
                ingestReaderVersion: failure.readerVersion,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.organizationId, organizationId),
            // The status the read saw, compared as text: a guard, never a write.
            sql`${documents.status} = ${from.status}`,
            sameDispatch(from.jobId),
          ),
        )
        .returning({
          scope: documents.scope,
          projectId: documents.projectId,
          folderId: documents.folderId,
          filename: documents.filename,
          createdBy: documents.createdBy,
          status: documents.status,
          screeningOutcome: documents.screeningOutcome,
          screenedHash: documents.screenedHash,
          dispatchedHash,
        })
      if (!moved) return false
      // The versions holding the bytes this job judged take the same verdict
      // (migration 0131). A read that ended without one (`failed`), or that was
      // stopped before it could judge them (`cancelled`), says nothing.
      if (resolution.status !== 'failed' && resolution.status !== 'cancelled') {
        await recordVersionVerdict(tx, documentId, organizationId, {
          judgedHash: resolution.status === 'completed' ? moved.screenedHash : moved.dispatchedHash,
          passed: resolution.status === 'completed' && verdictPasses(moved),
        })
      }
      if (resolution.status === 'quarantined') {
        await tx
          .insert(documentQuarantineDecisions)
          .values({
            organizationId,
            documentId,
            jobId: from.jobId,
            scope: moved.scope,
            projectId: moved.projectId,
            folderId: moved.folderId,
            filename: moved.filename.slice(0, 500),
            reasons: auditedQuarantineReasons(verdict),
            reasonsOmitted: verdict?.omitted ?? 0,
            checked: verdict?.checked ?? '',
            uploadedBy: moved.createdBy,
          })
          .onConflictDoNothing({ target: [documentQuarantineDecisions.documentId, documentQuarantineDecisions.jobId] })
      }
      return true
    }),
  )
}

/**
 * A reviewer's release of a held document (ADR-0086): who, when, and which
 * bytes. Guarded on the row still being held at rest with the bytes the
 * reviewer saw, so a release that raced a re-upload releases nothing. Returns
 * whether it took. A quarantine is released this way, and so is a file the gate
 * never reached a verdict on (its reading failed): before 2026-10-08 that file
 * stayed held with no way out.
 */
export async function markScreeningReleased(
  documentId: string,
  organizationId: string,
  release: { contentHash: string; releasedBy: string; releasedAt: Date },
): Promise<boolean> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(documents)
        .set({
          status: 'uploaded',
          errorMessage: null,
          // Only a quarantined row carries a verdict (migration 0148's CHECK),
          // and the release is how a row stops being one.
          quarantine: null,
          // The held verdict (`quarantined`, or a reading that failed) is the
          // reviewer's to lift, and they lifted it (migration 0134).
          ingestFailureCategory: null,
          ingestRetryable: null,
          screeningOutcome: 'released',
          // The release is a verdict about these bytes (migration 0123).
          screenedHash: release.contentHash,
          screeningReleasedHash: release.contentHash,
          screeningReleasedBy: release.releasedBy,
          screeningReleasedAt: release.releasedAt,
          updatedAt: release.releasedAt,
        })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.organizationId, organizationId),
            // Held and at rest: a quarantine, or a file the gate never reached a
            // verdict on (ADR-0086). A file in flight is the job's, not a reviewer's.
            heldAtRest(),
            eq(documents.contentHash, release.contentHash),
          ),
        )
        .returning({ id: documents.id })
      if (updated.length === 0) return false
      // The versions holding the released bytes are released with them (migration 0131).
      await recordVersionVerdict(tx, documentId, organizationId, { judgedHash: release.contentHash, passed: true })
      return true
    }),
  )
}
