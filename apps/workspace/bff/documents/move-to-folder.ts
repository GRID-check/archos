/**
 * Re-file a document into another folder — or out of every folder.
 *
 * Folders could be created, renamed, moved and deleted, and a document could be
 * filed into one AT UPLOAD and never again: `documents.folder_id` was written
 * once and had no other writer. A file dropped into the wrong folder, or
 * uploaded before the folder existed, stayed where it landed for good. That is
 * the one dead end left in the filing model, and it gets worse the more the
 * folder tree can be reorganised.
 *
 * One path for both shelves that have folders (ADR-0078): a project's Dateien
 * and the org-wide Archiv. The document's own row says which shelf it is on, the
 * shelf says who may move it (`@/lib/documents/shelf-authz`) and which folders
 * are valid destinations (`findShelfFolder`), and nothing else differs. A
 * session attachment is on neither and is refused.
 *
 * Deliberately its own module and its own route rather than a field on
 * `PATCH /api/documents/{id}`: that route renames and tags, resolving the
 * permission from the row, and a filing move needs the destination check and
 * the backend mirror below.
 */

import { eq } from 'drizzle-orm'
import { ApiError } from '@/lib/api/errors'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema/documents'
import { getProjectFolderAccess, requireFolderWrite } from '@/lib/authz/folder-access'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  collectionFileRef,
  collectionFileUrl,
  purgeIngestedChunks,
  type CollectionFileRef,
} from '@/lib/documents/collection-file-ref'
import { IN_FLIGHT_DOCUMENT_STATUSES } from '@/lib/documents/document-status'
import { PURGE_TIMEOUT_MS, placeProjectDocuments } from '@/lib/projects/collection-placement'
import { assertIfcMayBeFiledIn } from '@/lib/projects/ifc-folder-guard'
import { findProjectInOrg } from '@/lib/projects/repository'
import { findDocumentForSession } from './access'
import { reingestDocument } from './reingest'
import { documentShelf, type DocumentShelf } from './shelf'
import { requireShelfWrite } from './shelf-authz'
import { findShelfFolder } from './shelf-folders'
import { publishShelfChanged } from './shelf-live'

/** Same ceiling the other backend mirrors use (`BACKEND_FETCH_TIMEOUT_MS` in `@/lib/documents/ingest-dispatch`). */
const BACKEND_MIRROR_TIMEOUT_MS = 10_000

/** What the caller is told when the destination is not a folder of the document's shelf. */
const FOLDER_NOT_FOUND: Record<DocumentShelf['kind'], string> = {
  project: 'Folder not found in this project.',
  office_shelf: 'Folder not found in the office shelf.',
}

export interface MoveDocumentInput {
  documentId: string
  /** The destination. `null` files the document at the shelf root. */
  folderId: string | null
  /**
   * Move only if the document is still in this folder (`null`: the root);
   * omitted, from wherever it is. A bulk move that decided on what it read
   * earlier (a root sort's apply, its undo) says where it expects the
   * document, so it never moves one somebody has filed since.
   */
  expectedFolderId?: string | null
}

export interface MoveDocumentResult {
  id: string
  folderId: string | null
}

/** The collection a crossing move must still be placed in, for the caller to place once. */
interface PlacementDue {
  projectId: string
  collectionName: string
}

export type MoveDocumentOutcomeResult =
  | {
      ok: true
      document: MoveDocumentResult
      /** Moved, but not yet in the collection its folder calls for: only a crossing move can be. */
      pending?: boolean
      /** False when the document was already in the destination and nothing was written. */
      changed?: boolean
      /** Set only by a deferred crossing move: the caller runs placement for this project. */
      placementDue?: PlacementDue | null
    }
  | { ok: false; error: string }

export interface MoveDocumentOptions {
  /** Internal to {@link moveDocumentsToFolders}, which runs one placement pass per project after its moves. */
  deferPlacement?: boolean
}

/** The document is no longer where the caller expected it; it is left where it is. */
export const MOVED_SINCE_MESSAGE = 'The document was moved since; it was left where it is.'

const IN_FLIGHT_MESSAGE =
  'This document is still being processed. Move it across a restriction once processing has finished.'
const PURGE_FAILED_MESSAGE = 'The document could not be removed from its current collection, so it was not moved. Try again.'

export async function moveDocumentToFolder(
  input: MoveDocumentInput,
  session: AuthorizedSession,
  { deferPlacement = false }: MoveDocumentOptions = {},
): Promise<MoveDocumentOutcomeResult> {
  const db = getDb()

  // The document is read FIRST and without a shelf permission check, because
  // the shelf it is on is what the permission is checked against. It is read
  // org-scoped and through the hold (ADR-0086), so a document in another
  // tenant, or a held file this session neither uploaded nor reviews, is
  // simply not found.
  const document = await findDocumentForSession(session, input.documentId)

  if (!document) return { ok: false, error: 'Document not found.' }
  if (input.expectedFolderId !== undefined && document.folderId !== input.expectedFolderId) {
    return { ok: false, error: MOVED_SINCE_MESSAGE }
  }
  const shelf = documentShelf(document)
  if (!shelf) {
    // A session attachment. It is filed nowhere, and the database agrees.
    return { ok: false, error: 'Only project and Archiv documents live in folders.' }
  }

  await requireShelfWrite(session, shelf)

  // A project's folders have access per role (ADR-0087, ADR-0088); the
  // Archiv's do not. Both ends must be visible to the mover: a document in a
  // folder they may not read does not exist for them, and neither does such a
  // destination. Moving out of a folder and into another is a write on both: a
  // read-only end refuses (403), whichever it is. Restricted folders do not
  // hold IFC models until their building data is partitioned: a 409, thrown,
  // because the route turns `ok: false` into 400.
  // The collection the destination's access calls for; the Archiv has one.
  let targetCollection = document.collectionName
  if (shelf.kind === 'project') {
    const project = await findProjectInOrg(shelf.projectId, session.organizationId)
    if (!project) return { ok: false, error: 'Document not found.' }
    const access = await getProjectFolderAccess(session, shelf.projectId, project.collectionName)
    if (!access.isVisible(document.folderId)) return { ok: false, error: 'Document not found.' }
    if (!access.isVisible(input.folderId)) return { ok: false, error: FOLDER_NOT_FOUND.project }
    await requireFolderWrite(session, shelf.projectId, [document.folderId, input.folderId])
    targetCollection = access.collectionFor(input.folderId)
    assertIfcMayBeFiledIn(document.filename, targetCollection, project.collectionName)
  }

  // The destination has to be a folder of the SAME shelf (and tenant). Without
  // this the folder id is an unguessable-but-forgeable pointer into another
  // tree, and the document would vanish from the listing that filters by folder.
  let destinationPath: string | null = null
  if (input.folderId) {
    const folder = await findShelfFolder(shelf, session.organizationId, input.folderId)
    if (!folder) return { ok: false, error: FOLDER_NOT_FOUND[shelf.kind] }
    destinationPath = folder.path
  }

  if (document.folderId === input.folderId) {
    return {
      ok: true,
      document: { id: document.id, folderId: document.folderId },
      pending: false,
      placementDue: null,
      changed: false,
    }
  }

  // Across a restriction boundary the chunks leave the collection they are in
  // BEFORE the row says it is in a restricted folder. Placement reads the target
  // from the row, so the write cannot simply come first and be left to the
  // placement pass: a failed purge would then leave the document filed in the
  // restricted folder with its chunks still answering the open collection. So
  // the purge runs first, by the collection the row is in now, and a failed
  // purge refuses the move with nothing written. Placement purges it again
  // afterwards; the backend answers a purge of a file with no chunks as success.
  const crossing = shelf.kind === 'project' && targetCollection !== document.collectionName
  if (crossing) {
    if (IN_FLIGHT_DOCUMENT_STATUSES.has(document.status.toLowerCase())) return { ok: false, error: IN_FLIGHT_MESSAGE }
    const ref = collectionFileRef(document)
    if (ref && !(await purgeIngestedChunks(getBackendUrl(), ref, PURGE_TIMEOUT_MS, { permanent: true }))) {
      return { ok: false, error: PURGE_FAILED_MESSAGE }
    }
  }

  let updated: MoveDocumentResult
  try {
    ;[updated] = await db
      .update(documents)
      .set({ folderId: input.folderId, updatedAt: new Date() })
      .where(eq(documents.id, document.id))
      .returning({ id: documents.id, folderId: documents.folderId })
  } catch (error) {
    // The purge went through and the row did not move: it is still in its open
    // folder with nothing left to answer for it. Read it into that collection
    // again, then let the failure surface.
    if (crossing) await restoreAfterFailedMove(session, document.id)
    throw error
  }
  // Before the mirrors below: the row is where the workspaces read from.
  publishShelfChanged(session.organizationId, shelf)
  const moved: MoveDocumentResult = { id: updated.id, folderId: updated.folderId }

  // Across a restriction the document then belongs in another collection:
  // placement re-points the row into it, under its new path, so the path mirror
  // below has nothing to add. Until placement has done so the document is in
  // no collection at all, which is safe; the placement sweep finishes it.
  if (crossing) {
    const placementDue = { projectId: shelf.projectId, collectionName: targetCollection }
    if (deferPlacement) return { ok: true, document: moved, pending: true, placementDue, changed: true }
    await placeProjects(session.organizationId, [shelf.projectId])
    const placed = await isInCollection(session, document.id, targetCollection)
    return { ok: true, document: moved, pending: !placed, placementDue: null, changed: true }
  }

  const backendRef = collectionFileRef({
    collectionName: document.collectionName,
    filename: document.filename,
    authoredBy: document.authoredBy,
    publishedVersionId: document.publishedVersionId,
  })
  if (backendRef) {
    await mirrorDocumentFolderPath(backendRef, destinationPath)
  }

  return { ok: true, document: moved, pending: false, placementDue: null, changed: true }
}

/**
 * Run placement once for each project. A failure is logged rather than thrown:
 * the purge has already happened, so the document is findable nowhere, and the
 * placement sweep finishes what placement did not.
 */
async function placeProjects(organizationId: string, projectIds: Iterable<string>): Promise<void> {
  for (const projectId of new Set(projectIds)) {
    try {
      await placeProjectDocuments(organizationId, projectId)
    } catch (error) {
      console.warn(`[documents] placement of project ${projectId} failed; the placement sweep finishes it`, error)
    }
  }
}

/** Whether the document's row is in the collection its folder calls for, as the row reads now. */
async function isInCollection(session: AuthorizedSession, documentId: string, collectionName: string): Promise<boolean> {
  const after = await findDocumentForSession(session, documentId)
  return after?.collectionName === collectionName
}

export interface DocumentMoveOutcome {
  documentId: string
  ok: boolean
  error: string | null
  /** Moved, but not yet in the collection its folder calls for; placement finishes it. Absent when it is placed. */
  pending?: boolean
  /** Whether the move wrote anything: false for a document already in its destination. */
  changed?: boolean
}

export interface MoveDocumentsOptions {
  /**
   * Epoch milliseconds after which no further move is started. The moves not
   * reached are simply absent from the answer, so a job slice stops inside its
   * time and carries on from the first one missing.
   */
  deadline?: number
  /**
   * Told how many moves are done before each next one starts, so a job slice
   * can show its progress while it runs. The last count is the answer itself.
   */
  onProgress?: (done: number) => Promise<void> | void
  /**
   * Moves in flight at once (default 1). The moves are started in order and
   * every one started finishes, so the answer is still the first N moves, in
   * order: a deadline leaves a prefix, never a gap.
   */
  concurrency?: number
}

/**
 * Several moves, each through {@link moveDocumentToFolder} with every check it
 * makes: a bulk move is that move repeated, never a shortcut past it. One that
 * is refused or throws is reported and the rest go on, so a single read-only
 * folder does not stop a sort of a thousand files. One at a time unless the
 * caller asks for more; the moves are of different documents, so they do not
 * contend.
 *
 * Placement is the one step that is not repeated per move. A crossing move
 * defers it, and after the moves placement runs ONCE per affected project: a
 * pass reads the whole tree, so N crossing moves cost one pass, not N. Every
 * crossing move's own purge, and the refusal of one whose purge failed, stay
 * per move, so the restricted content is no less protected than one move at a time.
 */
export async function moveDocumentsToFolders(
  moves: readonly MoveDocumentInput[],
  session: AuthorizedSession,
  { deadline, onProgress, concurrency = 1 }: MoveDocumentsOptions = {},
): Promise<DocumentMoveOutcome[]> {
  const settled: Array<{ outcome: DocumentMoveOutcome; placementDue?: PlacementDue }> = []
  let next = 0
  let done = 0
  const lane = async (): Promise<void> => {
    while (next < moves.length) {
      if (deadline !== undefined && Date.now() >= deadline) return
      const index = next++
      if (done > 0) await onProgress?.(done)
      settled[index] = await moveOne(moves[index], session)
      done += 1
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, moves.length)) }, lane))
  // Started in order and all finished: `settled` has no hole before its end.
  const outcomes = settled.map((item) => item.outcome)
  const crossed = settled.flatMap((item) => (item.placementDue ? [{ outcome: item.outcome, placementDue: item.placementDue }] : []))
  // One pass per project, then each crossed document is read back: a document
  // the pass did not place stays pending, and the sweep places it.
  await placeProjects(
    session.organizationId,
    crossed.map((item) => item.placementDue.projectId),
  )
  for (const { outcome, placementDue } of crossed) {
    outcome.pending = !(await isInCollection(session, outcome.documentId, placementDue.collectionName))
  }
  return outcomes
}

/** One move of a batch, as its outcome: a refusal or an error is reported, never thrown. */
async function moveOne(
  move: MoveDocumentInput,
  session: AuthorizedSession,
): Promise<{ outcome: DocumentMoveOutcome; placementDue?: PlacementDue }> {
  try {
    const result = await moveDocumentToFolder(move, session, { deferPlacement: true })
    if (!result.ok) return { outcome: { documentId: move.documentId, ok: false, error: result.error, pending: false } }
    return {
      outcome: {
        documentId: move.documentId,
        ok: true,
        error: null,
        pending: result.pending,
        changed: result.changed ?? true,
      },
      placementDue: result.placementDue ?? undefined,
    }
  } catch (error) {
    // A refusal says what it is; anything else is logged here and never reaches the body.
    if (!(error instanceof ApiError)) console.error(`[documents] move of ${move.documentId} failed`, error)
    return {
      outcome: {
        documentId: move.documentId,
        ok: false,
        error: error instanceof ApiError ? error.message : 'Move failed.',
        pending: false,
      },
    }
  }
}

/** Re-read a document whose chunks were purged for a move that then did not happen. Best-effort, logged. */
async function restoreAfterFailedMove(session: AuthorizedSession, documentId: string): Promise<void> {
  try {
    await reingestDocument(session, documentId)
  } catch (error) {
    console.error(`[documents] ${documentId} lost its chunks to a move that failed, and could not be re-read`, error)
  }
}

/**
 * Tell the backend where this document now lives (ADR-0049).
 *
 * The Python side files documents under the materialised PATH, so a move that
 * only wrote `documents.folder_id` would leave the agent's inventory and its
 * `knowledge_search folder=` filter naming the folder the file just left — a
 * document findable under a folder it is no longer in.
 *
 * The subtree mirror in `@/lib/documents/shelf-folders` cannot express this:
 * that one rewrites a path PREFIX, and a document leaving `Brandschutz` for
 * `Statik` shares no prefix with where it was. Hence the per-document endpoint.
 *
 * Best-effort, with the same ordering argument as the display-title and
 * subtree mirrors: `documents.folder_id` above is the durable record of where
 * the file lives, and a backend that is down must not fail a move the user is
 * entitled to. The bounded cost is that the agent keeps the old folder until
 * the next move or re-ingest.
 */
async function mirrorDocumentFolderPath(ref: CollectionFileRef, folderPath: string | null): Promise<void> {
  try {
    await fetch(collectionFileUrl(getBackendUrl(), ref, '/folder-path'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
      signal: AbortSignal.timeout(BACKEND_MIRROR_TIMEOUT_MS),
    })
  } catch {
    // ignore — see the note above; `documents.folder_id` is the durable truth.
  }
}
