/**
 * Changing a document: its tags, its name, and erasing or deleting it.
 */

import 'server-only'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import { recordAuditEvent } from '@/lib/audit/service'
import { filedInOf } from '@/lib/audit/document-names'
import { getBackendUrl } from '@/lib/backend-proxy'
import { BadRequestError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { ALLOWED_TAGS, MAX_TOPICS, MAX_TOPIC_LENGTH } from './tag-vocabulary'
import { deleteAssignmentsForResource } from '@/lib/assignments/repository'
import { purgeResourceCollaboration } from '@/lib/collaboration/cleanup'
import { assertNoActiveHold } from '@/lib/compliance/holds'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { documentShelf, projectShelf } from './shelf'
import { publishShelfChanged } from './shelf-live'
import { collectionFileRef, collectionFileUrl, purgeIngestedChunks } from './collection-file-ref'
import { deleteProjectDocument, setDocumentDisplayName } from './repository'
import { documentDisplayName, validateDocumentName } from './display-name'
import { findDocumentForSession, getAccessibleDocument } from './access'
import { eraseDocumentObjectsOrKeepRow } from './object-cleanup'
import { refreshSearchRows } from '@/lib/search/refresh-rows'
import { BACKEND_FETCH_TIMEOUT_MS } from './ingest-dispatch'

/**
 * Replace a document's controlled tags. Requires `project:edit`. The document
 * row maps to the backend's `(collectionName, filename)` summary key; the edit
 * is proxied to the Python tag endpoint, which is the authority on the
 * vocabulary. Tags are also validated here against the mirrored `ALLOWED_TAGS`
 * so an obviously-bad request fails fast (400) without a backend round-trip;
 * an empty list clears the tags. A missing summary row surfaces as 404.
 *
 * `topics` is the model's keyword list, which a person may correct. It is
 * forwarded only when given, so a tag-only edit leaves the topics alone.
 */
export async function updateDocumentTags(
  session: AuthorizedSession,
  documentId: string,
  tags: string[],
  topics?: string[]
): Promise<{ id: string; tags: string[]; topics?: string[] }> {
  const doc = await getAccessibleDocument(session, documentId, 'write')

  const offending = tags.filter((tag) => !ALLOWED_TAGS.has(tag))
  if (offending.length > 0) {
    throw new BadRequestError('Tags outside the controlled vocabulary are not allowed', {
      invalidTags: offending,
    })
  }
  if (topics && (topics.length > MAX_TOPICS || topics.some((t) => t.length < 1 || t.length > MAX_TOPIC_LENGTH))) {
    throw new BadRequestError(`Topics must be at most ${MAX_TOPICS} keywords of 1 to ${MAX_TOPIC_LENGTH} characters`)
  }

  // The same gate as the read paths, on a WRITE. There is no backend summary row
  // for a document a machine wrote (never ingested), so the honest answer is the
  // 404 the backend itself gives for a non-colliding agent row — and the gate is
  // what makes the COLLIDING one answer the same way instead of overwriting the
  // controlled tags of the human document sharing the filename.
  const ref = collectionFileRef(doc)
  if (!ref) throw new NotFoundError()

  let res: Response
  try {
    res = await fetch(collectionFileUrl(getBackendUrl(), ref, '/tags'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(topics === undefined ? { tags } : { tags, topics }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
  } catch {
    // Includes a TimeoutError abort — treat a hung backend like any other
    // transport failure rather than letting the request hang.
    throw new UpstreamError('Could not reach the document service')
  }

  if (res.status === 404) throw new NotFoundError()
  if (res.status === 400) {
    throw new BadRequestError('Tags outside the controlled vocabulary are not allowed')
  }
  if (!res.ok) throw new UpstreamError('The document service rejected the tag update')

  // Tags and topics are search filters: the person who set them finds the
  // document by them at once (ADR-0136). Never fails the write.
  const [body] = await Promise.all([
    res.json().catch(() => ({})),
    refreshSearchRows(session.organizationId, [doc]),
  ])
  const answer: { id: string; tags: string[]; topics?: string[] } = {
    id: doc.id,
    tags: Array.isArray(body.tags) ? body.tags : tags,
  }
  if (topics !== undefined) answer.topics = Array.isArray(body.topics) ? body.topics : topics
  return answer
}

/**
 * Rename a document — the label, never the file.
 *
 * Scope-aware like every other item operation here: `getAccessibleDocument`
 * applies per-project FGA to a project document and `org:office_shelf:manage` to an
 * Archiv one, so both corpora rename through this one function and one route.
 *
 * ## What actually changes
 *
 * `display_name` in the BFF row, and `display_title` on the backend's metadata
 * row for the same document. Those are the two places a user-facing name is
 * read from — the file lists and preview here, the citation chips there — and
 * they are written together so a renamed document does not answer to two
 * different names depending on which surface you are looking at.
 *
 * `filename` is untouched. It is the join key to the stored object and to every
 * chunk in the retrieval index (see migration 0048), so renaming it would
 * detach the document from its own content. That is also why this needs no
 * re-ingestion: nothing about the indexed document changed.
 *
 * The backend PATCH is BEST-EFFORT, and the ordering says which side wins. The
 * durable rename is the row here; a backend that is down, slow, or has no
 * metadata row for the document (nothing was ever summarized — a failed
 * ingestion, or a model, which has no summary row at all) must not stop a
 * person from correcting a file name. The consequence is bounded and visible:
 * the citation chip keeps the old title until the next rename.
 *
 * Passing `null` clears the rename and restores the file's own name.
 */
export async function renameDocument(
  session: AuthorizedSession,
  documentId: string,
  requestedName: string | null,
  request: Request
): Promise<{ id: string; filename: string; displayName: string | null }> {
  const doc = await getAccessibleDocument(session, documentId, 'write')

  let displayName: string | null = null
  if (requestedName !== null) {
    const validated = validateDocumentName(requestedName)
    if (!validated.ok) {
      throw new BadRequestError('The document name is not usable', { reason: validated.reason })
    }
    // A rename back to the file's own name is a CLEAR, not a stored duplicate.
    // Otherwise the column would hold a value identical to `filename` and the
    // "has this been renamed" question — which the UI asks to decide whether to
    // offer "restore original name" — would answer yes for a document nobody
    // renamed.
    displayName = validated.value === doc.filename ? null : validated.value
  }

  await setDocumentDisplayName(documentId, session.organizationId, displayName)
  publishShelfChanged(session.organizationId, documentShelf(doc))

  // Mirror the name onto the backend's metadata row so citation chips follow
  // the rename immediately, with no re-ingest (the retrieval layer prefers a
  // stored `display_title` over the derived filename default). Best-effort by
  // design — see the note above.
  //
  // Gated on authorship like every other `(collection, filename)` call: a
  // machine-authored row has no metadata row over there to mirror onto, and on a
  // filename collision this PATCH would retitle the HUMAN document's citation
  // chips — renaming one file would silently rename another. Skipping costs
  // nothing that is not already accepted here: the mirror is best-effort, and
  // the durable rename is the row written above.
  const mirrorRef = collectionFileRef(doc)
  if (mirrorRef) {
    try {
      await fetch(collectionFileUrl(getBackendUrl(), mirrorRef, '/display-title'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_title: displayName }),
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      })
    } catch {
      // ignore — the durable rename is the row above; the chip catches up on the
      // next rename or the next re-ingestion.
    }
  }

  // Data-provenance event: who called which file what. Both names are
  // user-controlled, so both are capped before they reach the trail.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action:
      doc.scope === 'office_shelf' || doc.projectId === null
        ? 'office_shelf.document.renamed'
        : 'document.renamed',
    targetType: 'document',
    targetId: documentId,
    // A document under a folder not every member may read is not named (ADR-0087).
    filedIn: filedInOf(doc),
    metadata: {
      filename: doc.filename.slice(0, 200),
      previousName: documentDisplayName(doc).slice(0, 200),
      displayName: (displayName ?? doc.filename).slice(0, 200),
      collectionName: doc.collectionName,
    },
    request,
  })

  return { id: documentId, filename: doc.filename, displayName }
}

/**
 * The erasure steps of one project document, after its access check and its
 * legal-hold check: chunks, objects (every version, rendition, thumbnail and
 * extracted image), grants and assignments, the row, then the chunks once
 * more. Shared by {@link deleteDocument} and the purge of a folder from the
 * Papierkorb (`lib/projects/folder-bin.ts`), so a document leaves by one path
 * whichever way it goes. Idempotent: a document whose row is already gone is a
 * no-op for every step. Answers whether the backend confirmed the first chunk
 * purge (`null`: the row owns no chunks).
 */
export async function eraseProjectDocument(doc: Document, organizationId: string): Promise<boolean | null> {
  const projectId = doc.projectId
  if (projectId === null) throw new NotFoundError()
  // Best-effort: remove the ingested chunks so a deleted document stops showing
  // up in retrieval. A backend hiccup must not block the object and row
  // cleanup below, so it is recorded on the audit event rather than thrown.
  //
  // No ref → no chunks to purge, and this is where that mattered most. A
  // machine-authored row was never dispatched to `/v1/ingest`, so `file_ids:
  // [doc.filename]` names nothing of its own — and on the filename collision
  // `generatedFilename` makes reachable, it names a HUMAN document's chunks and
  // deletes them. That document keeps `status: 'completed'`, keeps its green
  // „zitierbar“ badge and its Ask affordance, and answers nothing from then on:
  // a silent, unlogged, unrecoverable content loss triggered by deleting an
  // unrelated file. The purge is skipped rather than made conditional on the
  // collision, because for an agent row it is ALWAYS wrong, collision or not.
  const purgeRef = collectionFileRef(doc)
  // `null`: nothing of its own to purge. `false`: the backend did not confirm,
  // and the audit row says so — the platform vector reconcile is the sweep.
  const chunksPurged = purgeRef
    ? // Permanent: the document is gone, and its Fassung links with it (ADR-0099).
      await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_FETCH_TIMEOUT_MS, { permanent: true })
    : null

  await eraseDocumentObjectsOrKeepRow(doc, organizationId)

  // Only once the bytes are gone. Grants and assignments are cheap to keep and
  // expensive to lose: a delete that stops at the object store above leaves a
  // document people can still open, and it should still be shared with them.
  await Promise.all([
    purgeResourceCollaboration('document', doc.id).catch(() => undefined),
    deleteAssignmentsForResource(organizationId, 'document', doc.id).catch(
      () => undefined
    ),
  ])

  await deleteProjectDocument(doc.id, organizationId, projectId)
  publishShelfChanged(organizationId, projectShelf(projectId))

  // Once more, now that the row is gone: an ingest of this document that
  // asked `GET /api/internal/document-exists` before the row went saw it,
  // and kept chunks it inserted after the first purge (ADR-0054, correction
  // 18). Any check from here on reads „gone“ and discards its own. Logged
  // inside, never thrown: the row is gone, and the orphan sweep is the net.
  if (purgeRef) await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_FETCH_TIMEOUT_MS, { permanent: true })

  return chunksPurged
}

/**
 * Delete a document permanently: purge its RAG chunks (best-effort), remove the
 * SeaweedFS object, delete the row, and audit. A project document needs write
 * on its folder; an office shelf document goes to
 * {@link import('@/lib/office-shelf/service').deleteOfficeShelfDocument}, behind
 * `org:office_shelf:manage`. A legal hold on the document, its project, its
 * uploader or the organization refuses it with a 409 before anything is erased
 * (`@/lib/compliance/holds`).
 *
 * A session attachment goes through `/api/session/documents/[id]` with its own
 * authorization, so it surfaces here as a 404. The scope is asked for by name:
 * "has no project" used to mean "is an Archiv document" and stopped meaning that
 * when session documents became rows.
 */
export async function deleteDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request
): Promise<void> {
  // Through the hold (ADR-0086): a member who may not see a held file is told
  // it does not exist, rather than allowed to delete it.
  const doc = await findDocumentForSession(session, documentId)
  if (doc?.scope === 'office_shelf') {
    // Imported here: the office shelf's service imports this module.
    const { deleteOfficeShelfDocument } = await import('@/lib/office-shelf/service')
    return deleteOfficeShelfDocument(session, documentId, request)
  }
  if (!doc || doc.scope !== 'project' || doc.projectId === null) throw new NotFoundError()

  // A delete is a write in the document's folder (ADR-0088): the project's
  // document-write permission, and write on the folder. A folder the session
  // may not read is not found; one it may only read refuses (403).
  await requireFolderWrite(session, doc.projectId, [doc.folderId])
  // After the access check (an unauthorized caller learns nothing, not even
  // that a hold exists) and before the first destructive step below.
  await assertNoActiveHold(session.organizationId, 'document', documentId)

  const chunksPurged = await eraseProjectDocument(doc, session.organizationId)

  // Data-provenance event: who removed which file from which project.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.deleted',
    targetType: 'document',
    filedIn: filedInOf(doc),
    // Filename is user-controlled — cap it before it reaches the trail.
    metadata: {
      projectId: doc.projectId,
      filename: doc.filename.slice(0, 200),
      collectionName: doc.collectionName,
      chunksPurged,
    },
    request,
  })
}
