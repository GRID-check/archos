/**
 * One document as a listing row, by id (`GET /api/documents/[id]`, ADR-0102).
 *
 * The Files workspace reads a folder level page by page, so a link to a
 * document (`?doc=`, `?compare=`, a model on the stage) can name one that no
 * loaded page holds. This is how the workspace gets it without draining the
 * shelf: the same row a listing page would carry, through the same WHERE and
 * the same hydration.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { getAccessibleDocument } from './access'
import { findShelfDocumentListRow } from './repository'
import { documentShelf } from './shelf'
import { toListedDocuments, type ListedDocument } from './shelf-listing'

/**
 * Authorized like every item route under `/api/documents/[id]`
 * (`getAccessibleDocument`: project FGA and folder visibility for a project
 * document, membership of the organization for an Archiv document, the hold
 * for both), then read through the listing's own predicates with the reader
 * the shelf's listing uses. A chat attachment is on no shelf and is not found
 * here; an archived document is, because a link names it on purpose.
 */
export async function getListedDocument(session: AuthorizedSession, documentId: string): Promise<ListedDocument> {
  const doc = await getAccessibleDocument(session, documentId)
  const shelf = documentShelf(doc)
  if (!shelf) throw new NotFoundError()
  const reader = await shelfReaderFor(session, doc)
  const row = await findShelfDocumentListRow(shelf, session.organizationId, documentId, {
    hiddenFolderIds: shelf.kind === 'project' ? await getHiddenFolderIds(session, shelf.projectId) : undefined,
    reader,
    includeArchived: true,
  })
  if (!row) throw new NotFoundError()
  // The reconcile on the way out can turn the row quarantined; then it is
  // narrowed again by the same rule, and a reader it hides gets a 404.
  const [listed] = await toListedDocuments(session, [row], reader)
  if (!listed) throw new NotFoundError()
  return listed
}
