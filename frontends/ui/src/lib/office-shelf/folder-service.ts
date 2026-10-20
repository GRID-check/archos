/**
 * The org-wide Archiv's folders — the Archiv half of the shelf-parameterised
 * folder core in `@/lib/documents/shelf-folders` (ADR-0078).
 *
 * The twin of `@/lib/projects/folder-service`, and the same code underneath,
 * authorization included (`@/lib/documents/shelf-authz`): any member of the
 * organization may read the tree, as they may read the Archiv itself; changing
 * it takes `org:archiv:manage` (`canManageOfficeShelf`), the permission that already
 * gates uploading and deleting there — a folder is a label on those documents,
 * so it is gated like them.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { OFFICE_SHELF } from '@/lib/documents/shelf'
import {
  createShelfFolder,
  deleteShelfFolder,
  ensureShelfFolderPaths,
  listShelfFolders,
  updateShelfFolder,
} from '@/lib/documents/shelf-folders'

export function listOfficeShelfFolders(session: AuthorizedSession) {
  return listShelfFolders(session, OFFICE_SHELF)
}

export function createOfficeShelfFolder(
  session: AuthorizedSession,
  input: { parentId?: string | null; name: string; description?: string | null },
) {
  return createShelfFolder(session, OFFICE_SHELF, input)
}

export function updateOfficeShelfFolder(
  session: AuthorizedSession,
  input: { folderId: string; name?: string; parentId?: string | null; description?: string | null },
) {
  return updateShelfFolder(session, OFFICE_SHELF, input)
}

export function deleteOfficeShelfFolder(session: AuthorizedSession, folderId: string) {
  return deleteShelfFolder(session, OFFICE_SHELF, folderId)
}

export function ensureOfficeShelfFolderPaths(
  session: AuthorizedSession,
  input: { parentId: string | null; paths: readonly string[] },
) {
  return ensureShelfFolderPaths(session, OFFICE_SHELF, input)
}
