/**
 * Listing a project's documents, and finding them by name.
 */

import 'server-only'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentAuthor } from '@/lib/db/schema/documents'
import { toListedDocuments, toListedLevelPage, type ListedDocument } from './shelf-listing'
import { projectShelf } from './shelf'
import type { DocumentLevelQuery } from './list-query'
import { listDocumentLevelPage, findProjectDocumentsByFilenames, findProjectDocumentsByNames, type DocumentNameMatchRow } from './repository'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'

/**
 * One page of a project's documents (ADR-0102, ADR-0131): one folder level, or
 * the whole shelf, in the reader's order, lazily reconciling in-flight
 * ingestion statuses with the backend and merging the backend's read-only
 * document metadata (summary, page/chunk counts, content types). The internal
 * `metadata` jsonb column (which carries `ingestJobId`) never leaves the BFF.
 *
 * `authoredBy` is pushed down to the query rather than filtered here: the
 * „Von Piloti" chip asks for the small minority of rows a machine wrote, and
 * migration 0063 gave that predicate its own partial index. Archived documents
 * have LEFT the working set, so they are absent unless the caller says
 * otherwise (ADR-0054).
 */
export async function listDocumentsPage(
  session: AuthorizedSession,
  projectId: string,
  options: { authoredBy?: DocumentAuthor; includeArchived?: boolean; level: DocumentLevelQuery }
): Promise<{ documents: ListedDocument[]; nextCursor: string | null }> {
  await requireProjectAccess(session, projectId, 'project:view')
  // A file in quarantine is listed for its uploader and its reviewers only (ADR-0086).
  const reader = await shelfReaderFor(session, { scope: 'project', projectId })
  const levelPage = await listDocumentLevelPage(projectShelf(projectId), session.organizationId, {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader,
    authoredBy: options.authoredBy,
    includeArchived: options.includeArchived,
    level: options.level,
  })
  return toListedLevelPage(session, levelPage, reader)
}

/**
 * The project's documents NAMED `filenames` (case-insensitive, either Unicode
 * form), as listing rows — the by-name resolve (`POST /api/documents/by-name`).
 *
 * For the readers that want particular documents rather than the corpus: a
 * citation chip, a surfaced-documents card, a file operation naming its file.
 * They used to read the first listing page and look the name up in it, so a
 * cited document older than the newest 500 resolved to nothing. Same gate and
 * same row as the listing; archived documents are left out as they are there.
 */
export async function resolveProjectDocumentsByName(
  session: AuthorizedSession,
  projectId: string,
  filenames: readonly string[]
): Promise<ListedDocument[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const reader = await shelfReaderFor(session, { scope: 'project', projectId })
  const rows = await findProjectDocumentsByFilenames(projectId, session.organizationId, filenames, {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader,
  })
  return toListedDocuments(session, rows, reader)
}

/**
 * Which of `names` this project's shelf already holds — the upload planner's
 * question, asked of the database rather than of the listing a browser loaded
 * (which is paged, can be narrowed by a filter, and leaves archived documents
 * out, while the upload replaces by filename across all of them).
 *
 * Same gate as the listing: the answer is names and ids a `project:view`
 * reader can already page through.
 */
export async function probeProjectDocumentNames(
  session: AuthorizedSession,
  projectId: string,
  names: readonly string[]
): Promise<DocumentNameMatchRow[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  // A name taken in a hidden folder is not reported: the upload refuses it
  // without saying where (`assertNameFreeInProject`). Nor is one held by
  // somebody else's quarantined file (ADR-0086): the upload refuses it as a
  // taken name (`assertMayReplaceQuarantined`).
  return findProjectDocumentsByNames(projectId, session.organizationId, names, {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader: await shelfReaderFor(session, { scope: 'project', projectId }),
  })
}

export type { ListedDocument }
