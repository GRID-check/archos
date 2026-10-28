/**
 * Re-indexing a whole project, a slice at a time on the job queue.
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { ForbiddenError } from '@/lib/api/errors'
import { NotFoundError } from '@/lib/api/errors'
import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolveDocumentFolderPath } from './folder-path'
import { collectionFileRef } from './collection-file-ref'
import { listProjectDocumentPage, type DocumentListRow } from './repository'
import { documentDisplayName } from './display-name'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { emptyCounts, recordJobFailure, requesterOf, type JobCounts, type JobSliceResult, type ReindexProjectPayload } from '@/lib/jobs-queue/types'
import { getAccessibleDocument } from './access'
import { internalRead } from './document-reader'
import { dispatchDocument } from './document-dispatch'

export interface ReindexProjectResult {
  projectId: string
  /**
   * The job doing the work, on the `bff-jobs` pool (ADR-0081). It outlives this
   * request and the process that took it: a restart gives its claim back and
   * the next worker resumes from the page it stopped at.
   */
  jobId: string
}

/**
 * Documents one reindex slice re-dispatches. Small on purpose: a slice is the
 * unit a draining worker waits for, so it is seconds of work, and the page the
 * job has got to is saved after every one.
 */
export const REINDEX_SLICE_DOCUMENTS = 25

/** Re-dispatch runs this many documents at a time. */
export const REINDEX_CONCURRENCY = 4

/**
 * Run `work` over `items`, at most `concurrency` at a time. One item's failure
 * is `work`'s to handle: this never rejects on its account.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++])
  })
  await Promise.all(workers)
}

/**
 * Rebuild every document's chunks in one project: authorize, then hand the walk
 * to a job.
 *
 * The walk used to run inside this request: up to ten thousand documents in
 * one POST, and a request that died half way left no record of which half.
 * Now the request checks that the caller may rebuild this project and enqueues
 * ONE job (`reindex_project`, bulk), answered 202 with its id. The job pages
 * through the documents on a `bff-jobs` pod, saves its place after every page
 * and dispatches each document to the backend with `priority: "bulk"`, so a
 * person's upload in the same organization is claimed first. A second click
 * while one is open returns that job instead of starting another.
 *
 * The project-wide form of re-reading an indexed document (`reingestDocument`
 * does it for one): every person-authored document with stored bytes goes
 * through `dispatchDocument` again, under its own row filename.
 *
 * There is NO chunk delete first. The backend replaces a version only once the
 * new one has indexed — `_find_previous_versions` collects the old ids before
 * the file is read, `_retire_previous_version` removes exactly those after the
 * file reaches SUCCESS (`llamaindex/adapter.py`; docs/technical-reference/
 * document-ingestion.md, "A re-upload replaces the previous version once it has
 * indexed"). This function used to DELETE the chunks and then dispatch, so any
 * dispatch or ingest failure — a backend blip, an encrypted PDF, a missing VLM
 * key — left a document that answered yesterday with zero chunks today. The
 * backend moved away from delete-first for exactly that reason; the pre-delete
 * here reintroduced it one tier up.
 *
 * What the pre-delete bought is not worth that. The replacement is keyed on the
 * row's own filename, which is also what the delete addressed, so there is no
 * name the delete reached that the replacement does not. The one residual case
 * is the backend's lookup of previous versions failing (it logs and ingests
 * anyway), which leaves a duplicate until the next re-read — a smaller harm
 * than an empty document, and a backend defect to fix there. Nor is this the
 * tool for an embedding-model change: that invalidates the whole collection,
 * which is rebuilt from an empty Chroma directory (same doc, "Embedding-model
 * changes invalidate stored vectors"), not by per-file deletes.
 *
 * Reach for this after a change to how chunks are BUILT rather than to what they are
 * built from — a chunker change alters no file, so nothing in the ordinary upload
 * path would notice.
 */
export async function reindexProject(
  session: AuthorizedSession,
  projectId: string
): Promise<ReindexProjectResult> {
  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])

  const open = await findOpenJobId({
    kind: 'reindex_project',
    organizationId: session.organizationId,
    matching: { projectId },
  })
  if (open) return { projectId, jobId: open }

  const payload: ReindexProjectPayload = {
    projectId,
    requester: requesterOf(session),
    cursor: null,
    counts: emptyCounts(),
  }
  const { jobId } = await enqueueJob({
    kind: 'reindex_project',
    organizationId: session.organizationId,
    payload,
  })
  return { projectId, jobId }
}

/**
 * Re-dispatch one document of a reindex. `skipped` for a row there is nothing
 * to rebuild from; a dispatch the backend refused throws.
 */
async function redispatchForReindex(
  session: AuthorizedSession,
  row: DocumentListRow
): Promise<'queued' | 'skipped'> {
  // Re-resolved rather than trusted from the list: this is the same read the
  // single-document path uses, it carries the storage key and bucket the list
  // row does not, and it re-checks access per document.
  const doc = await getAccessibleDocument(session, row.id, 'write')
  // Mid-flight rows are skipped: a second dispatch would double the work of
  // one that is running. Every in-flight spelling, not just two of them.
  // So is a quarantined one: it waits on a reviewer, and `dispatchDocument`
  // would leave it alone anyway (ADR-0086).
  if (!doc.storageKey || IN_FLIGHT_DOCUMENT_STATUSES.has(doc.status) || doc.status === 'quarantined') return 'skipped'

  // Belt to the query's braces. The listing already asks for `'user'` only, so
  // this is never null in practice; a row that somehow arrives here
  // machine-authored is skipped, not reported failed: it was never eligible,
  // and `dispatchDocument` would refuse it anyway.
  if (!collectionFileRef(doc)) return 'skipped'

  // The bucket the object is ACTUALLY in — see `reingestDocument` for why
  // defaulting this breaks per-organization documents in two directions.
  const { status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
    folderPath: await resolveDocumentFolderPath(doc, session.organizationId),
    priority: 'bulk',
  })
  // A dispatch the backend refused comes back `failed` rather than throwing;
  // the row says so, and the reindex summary has to as well.
  if (status === 'failed') throw new Error('dispatch failed')
  return 'queued'
}

/**
 * One slice of a `reindex_project` job: the next page of the project's
 * documents, re-dispatched, and the position to resume from.
 *
 * `payload` is the job's state, read back from the queue row, and this returns
 * the state to save. Re-running a slice (its worker died after the dispatches
 * and before the save) re-dispatches the same documents, which the backend
 * accepts: ingestion is idempotent per document and object.
 *
 * Every page, not the first: the keyset order is `created_at`, which a dispatch
 * never touches, so re-dispatching a page cannot move a row across the cursor.
 * `'user'` explicitly, not "everything": a machine-authored document must not be
 * indexed (see `dispatchDocument`), and reaching the dispatcher's refusal would
 * report a project-wide reindex as partially FAILED for rows that were never
 * eligible. The dispatcher is the invariant; this is the caller not asking a
 * question it already knows the answer to.
 */
export async function runReindexSlice(
  session: AuthorizedSession,
  payload: ReindexProjectPayload
): Promise<JobSliceResult<ReindexProjectPayload>> {
  try {
    // The caller's rights are checked again: a job can wait, and a person who
    // lost their role in the meantime must not have it rebuild the project.
    await requireProjectAccess(session, payload.projectId, ['project:documents:write', 'project:edit'])
  } catch (error) {
    if (!(error instanceof NotFoundError) && !(error instanceof ForbiddenError)) throw error
    console.warn(`[reindex] project ${payload.projectId}: the requester no longer has access; stopping`)
    return { done: true, payload }
  }

  // Every row, held ones too: a re-index is an ingest, and a held file is read
  // again through the same gate (a quarantined one is dispatched for nobody).
  const { rows, nextCursor } = await listProjectDocumentPage(payload.projectId, session.organizationId, {
    reader: internalRead('ingest'),
    authoredBy: 'user',
    cursor: payload.cursor ?? undefined,
    limit: REINDEX_SLICE_DOCUMENTS,
  })

  const counts: JobCounts = { ...payload.counts, failedNames: [...payload.counts.failedNames] }
  await forEachBounded(rows, REINDEX_CONCURRENCY, async (row) => {
    try {
      const outcome = await redispatchForReindex(session, row)
      counts[outcome] += 1
    } catch (error) {
      // A document in a folder the requester may not read, or may only read
      // (ADR-0088), is not theirs to re-read: skipped, and never named, since
      // its name is what a hidden folder hides.
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        counts.skipped += 1
        return
      }
      // One document's failure must not abandon the rest of the project.
      recordJobFailure(counts, documentDisplayName(row))
    }
  })

  const next = { ...payload, cursor: nextCursor, counts }
  if (!nextCursor) logReindexSummary(next)
  return { done: !nextCursor, payload: next }
}

function logReindexSummary(payload: ReindexProjectPayload): void {
  const { queued, skipped, failed, failedNames } = payload.counts
  const line =
    `[reindex] project ${payload.projectId}: ${queued} re-dispatched, ${skipped} skipped, ${failed} failed` +
    (failed > 0 ? ` (${failedNames.join(', ')}${failed > failedNames.length ? ', …' : ''})` : '')
  // A failure is something an operator should see; a clean run is not.
  if (failed > 0) console.warn(line)
  else console.debug(line)
}
