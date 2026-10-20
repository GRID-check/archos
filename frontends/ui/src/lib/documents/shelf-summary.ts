/**
 * A shelf's summary (ADR-0102): the counts behind the folder tiles and the
 * folder brief of a workspace that reads a folder level page by page, read
 * from Postgres in two bounded queries and nothing else (no backend call).
 *
 * Shared by a project's Dateien and the org-wide Archiv, like the listing
 * (ADR-0078). Each entry point authorizes its shelf exactly as that shelf's
 * listing does and passes the same reader and hidden folders, so the summary
 * counts exactly the rows the listing would show this reader.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { DocumentAuthor } from '@/lib/db/schema'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { OFFICE_SHELF, projectShelf, type DocumentShelf } from './shelf'
import { listShelfFailedDocuments, summarizeShelfFolders, type ShelfReadFilters } from './repository'
import type { ShelfSummary } from './shelf-summary-types'

/** The two filters the server answers; the summary takes them so its counts match the listing below it. */
export interface ShelfSummaryOptions {
  authoredBy?: DocumentAuthor
  includeArchived?: boolean
}

async function readShelfSummary(
  shelf: DocumentShelf,
  organizationId: string,
  filters: ShelfReadFilters,
): Promise<ShelfSummary> {
  const [folders, failed] = await Promise.all([
    summarizeShelfFolders(shelf, organizationId, filters),
    listShelfFailedDocuments(shelf, organizationId, filters),
  ])
  return { folders, ...failed }
}

/**
 * A project's shelf, behind the listing's gate (`project:view`), its reader
 * (a held upload is its uploader's and the reviewers', ADR-0086) and its
 * hidden folders (ADR-0087).
 */
export async function summarizeProjectDocuments(
  session: AuthorizedSession,
  projectId: string,
  options: ShelfSummaryOptions = {},
): Promise<ShelfSummary> {
  await requireProjectAccess(session, projectId, 'project:view')
  const reader = await shelfReaderFor(session, { scope: 'project', projectId })
  return readShelfSummary(projectShelf(projectId), session.organizationId, {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader,
    authoredBy: options.authoredBy,
    includeArchived: options.includeArchived,
  })
}

/**
 * The organization's Archiv. Any member may read it, as with `listOfficeShelf`; a
 * held upload is its uploader's and the curators' (ADR-0086). The Archiv has
 * no hidden folders.
 */
export async function summarizeOfficeShelfDocuments(
  session: AuthorizedSession,
  options: ShelfSummaryOptions = {},
): Promise<ShelfSummary> {
  const reader = await shelfReaderFor(session, { scope: 'archiv', projectId: null })
  return readShelfSummary(OFFICE_SHELF, session.organizationId, {
    reader,
    authoredBy: options.authoredBy,
    includeArchived: options.includeArchived,
  })
}
