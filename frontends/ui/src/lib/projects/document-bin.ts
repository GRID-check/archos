/**
 * One document to the bin, and back (ADR-0088, ADR-0131 rule 7).
 *
 * The bin holds folders: a folder entry is what the purge, the chunk purge,
 * the restore job and the legal-hold checks all work on. A document goes there
 * the way the clean-out sends it (ADR-0092, `cleanup-service.ts`): filed into a
 * folder of its own, made inside the folder it is in and named after it, and
 * that folder binned holding exactly this document (`onlyDocuments`). A folder
 * that inherits its parent's access has the parent's readers and collection, so
 * the move widens nobody's access and re-reads nothing; the bin purges the
 * chunks, as for any folder.
 *
 * The entry records the document (`documentId` on its payload), so the listing
 * names it and {@link restoreDocumentFromBin} takes the document back out: the
 * holder is restored (its restore job reads the document again), the document
 * is filed back where the holder now stands, and the empty holder goes. A
 * document that went to the bin with a folder is restored with that folder.
 *
 * All or nothing: when binning fails half way, what was done is undone and the
 * document is where it was.
 */

import 'server-only'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { findDocumentForSession } from '@/lib/documents/access'
import { documentDisplayName } from '@/lib/documents/display-name'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { projectShelf } from '@/lib/documents/shelf'
import { FOLDER_NAME_TAKEN } from '@/lib/documents/shelf-folders'
import { publishShelfChanged } from '@/lib/documents/shelf-live'
import { deleteEmptyCreatedFolder } from './cleanup-repository'
import { moveFolderToBin, restoreFolderFromBin } from './folder-bin'
import { findActiveBinEntry, findFolderInOrg, type FolderBinPayload } from './folder-bin-repository'
import {
  BINNED_WITH_FOLDER_REASON,
  DOCUMENT_HAS_NO_BIN_REASON,
  type DocumentBinResult,
  type DocumentRestoreResult,
} from './folder-bin-wire'
import { createProjectFolder } from './folder-service'
import { normalizeFolderName, validateFolderName } from './folders'

/** The reason a restore is refused for a document that is not in the bin. */
export const DOCUMENT_NOT_IN_BIN_REASON = 'document-not-in-bin'

/** How long a holder's name may be before a counter is added: under the folder name's 120. */
const HOLDER_NAME_MAX = 110

/** A project document the session may see, with its project; 404 or 409 otherwise. */
async function projectDocumentFor(session: AuthorizedSession, documentId: string) {
  const doc = await findDocumentForSession(session, documentId)
  if (!doc) throw new NotFoundError('Document not found')
  if (doc.scope !== 'project' || doc.projectId === null) {
    throw new ConflictError('Only a project document can go to the bin; an office shelf document is deleted permanently.', {
      reason: DOCUMENT_HAS_NO_BIN_REASON,
    })
  }
  return { doc, projectId: doc.projectId }
}

/** The folder a document is filed in, living or binned; null at the project root. */
async function folderOf(organizationId: string, projectId: string, folderId: string | null) {
  if (!folderId) return null
  return withTenant({ organizationId }, () => findFolderInOrg(getDb(), organizationId, projectId, folderId))
}

/** The holder's name: the document's own, made a valid folder name, numbered when a sibling has it. */
function holderName(documentName: string, attempt: number): string {
  const base = normalizeFolderName(documentName).slice(0, HOLDER_NAME_MAX).trim()
  const named = attempt === 1 ? base : `${base} (${attempt})`
  const checked = validateFolderName(named)
  return checked.ok && checked.name ? checked.name : `${attempt}`
}

async function makeHolder(session: AuthorizedSession, projectId: string, parentId: string | null, documentName: string) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const created = await createProjectFolder({ projectId, parentId, name: holderName(documentName, attempt) }, session)
    if (created.ok) return created.folder
    if (created.error !== FOLDER_NAME_TAKEN) throw new BadRequestError(created.error)
  }
  throw new ConflictError('Could not name the folder that takes the document to the bin.')
}

/**
 * Move one project document to the bin. Needs write on the folder it is in,
 * as deleting the folder would. Restorable until `purgeAfter`.
 */
export async function moveDocumentToBin(
  session: AuthorizedSession,
  documentId: string,
  request?: Request
): Promise<DocumentBinResult> {
  const { doc, projectId } = await projectDocumentFor(session, documentId)
  await requireFolderWrite(session, projectId, [doc.folderId])
  const current = await folderOf(session.organizationId, projectId, doc.folderId)
  if (current?.deletedAt) throw new ConflictError('This document is already in the bin.')

  const holder = await makeHolder(session, projectId, doc.folderId, documentDisplayName(doc))
  let moved = false
  try {
    const into = await moveDocumentToFolder({ documentId, folderId: holder.id, expectedFolderId: doc.folderId }, session)
    if (!into.ok) throw new BadRequestError(into.error)
    moved = true
    const binned = await moveFolderToBin(session, { projectId, folderId: holder.id }, request, {
      onlyDocuments: [documentId],
      documentId,
    })
    return { documentId, binEntryId: holder.id, purgeAfter: binned.purgeAfter.toISOString() }
  } catch (error) {
    await undoBin(session, projectId, documentId, doc.folderId, holder.id, moved)
    throw error
  }
}

/** Put a document back where it was and remove the holder, after a bin that failed. Logged, never thrown. */
async function undoBin(
  session: AuthorizedSession,
  projectId: string,
  documentId: string,
  folderId: string | null,
  holderId: string,
  moved: boolean
): Promise<void> {
  try {
    if (moved) {
      const back = await moveDocumentToFolder({ documentId, folderId, expectedFolderId: holderId }, session)
      if (!back.ok) throw new Error(back.error)
    }
    if (await deleteEmptyCreatedFolder(session.organizationId, projectId, holderId)) {
      publishShelfChanged(session.organizationId, projectShelf(projectId), { folders: true })
    }
  } catch (error) {
    console.error(`[document-bin] undoing a failed bin of ${documentId} in project ${projectId} failed`, error)
  }
}

/**
 * Take a document that went to the bin on its own back out: filed again in the
 * folder it came from (the project root when that folder is gone), and read
 * into the index again. Needs what restoring its entry needs. A document that
 * went with a folder is refused (409, {@link BINNED_WITH_FOLDER_REASON}, the
 * folder's id in `details.folderId`): restore that folder instead.
 */
export async function restoreDocumentFromBin(
  session: AuthorizedSession,
  documentId: string,
  request?: Request
): Promise<DocumentRestoreResult> {
  const { doc, projectId } = await projectDocumentFor(session, documentId)
  const holder = await folderOf(session.organizationId, projectId, doc.folderId)
  if (!holder?.deletedAt || holder.purgedAt) {
    throw new ConflictError('This document is not in the bin.', { reason: DOCUMENT_NOT_IN_BIN_REASON })
  }
  const rootId = holder.binRootId ?? holder.id
  const entry = await withTenant({ organizationId: session.organizationId }, () =>
    findActiveBinEntry(getDb(), session.organizationId, rootId)
  )
  const payload = (entry?.payload ?? null) as Partial<FolderBinPayload> | null
  if (rootId !== holder.id || payload?.documentId !== documentId) {
    throw new ConflictError('This document went to the bin with its folder; restore the folder instead.', {
      reason: BINNED_WITH_FOLDER_REASON,
      folderId: rootId,
    })
  }

  const { restoredTo } = await restoreFolderFromBin(session, { projectId, folderId: holder.id }, request)
  // The holder now stands where it was, or at the root when its parent is gone.
  const target = restoredTo === 'root' ? null : holder.parentId
  const back = await moveDocumentToFolder({ documentId, folderId: target, expectedFolderId: holder.id }, session)
  if (!back.ok) throw new BadRequestError(back.error)
  if (await deleteEmptyCreatedFolder(session.organizationId, projectId, holder.id)) {
    publishShelfChanged(session.organizationId, projectShelf(projectId), { folders: true })
  }
  return { documentId, folderId: target, restoredTo }
}
