/** Folder paths on the shelf and per-project document counts. */

import 'server-only'
import { and, count, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { OFFICE_SHELF, projectShelf, shelfFolderWhere, type DocumentShelf } from '../shelf'
import { documents } from '@/lib/db/schema/documents'
import { projectFolders } from '@/lib/db/schema/project-folders'
import { documentVisibleTo, type DocumentReader } from '../visibility'
import { outsideHiddenFolders } from './list'

/** Several folders' paths in one project, keyed by folder id; folders not in the project are absent. */
export async function findFolderPathsInProject(
  folderIds: readonly string[],
  projectId: string,
  organizationId: string,
): Promise<Map<string, string>> {
  if (folderIds.length === 0) return new Map()
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: projectFolders.id, path: projectFolders.path })
      .from(projectFolders)
      .where(
        and(
          inArray(projectFolders.id, [...folderIds]),
          eq(projectFolders.projectId, projectId),
          isNull(projectFolders.deletedAt),
        ),
      ),
  )
  return new Map(rows.map((row) => [row.id, row.path]))
}

/**
 * A folder's path on a shelf, scoped to it so a folder id from another project,
 * another shelf or another tenant can never redirect an upload or re-file a
 * document under a tree it is not in.
 */
async function findFolderPathOnShelf(
  shelf: DocumentShelf,
  folderId: string,
  organizationId: string,
): Promise<string | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ path: projectFolders.path })
      .from(projectFolders)
      .where(and(eq(projectFolders.id, folderId), shelfFolderWhere(shelf, organizationId)))
      .limit(1),
  )
  return row?.path ?? null
}

/** A project folder's path — see {@link findFolderPathOnShelf}. */
export function findFolderPathInProject(
  folderId: string,
  projectId: string,
  organizationId: string,
): Promise<string | null> {
  return findFolderPathOnShelf(projectShelf(projectId), folderId, organizationId)
}

/** An Archiv folder's path — see {@link findFolderPathOnShelf}. */
export function findFolderPathInOfficeShelf(folderId: string, organizationId: string): Promise<string | null> {
  return findFolderPathOnShelf(OFFICE_SHELF, folderId, organizationId)
}

/**
 * Document counts per project, for the projects grid.
 *
 * Takes the project ids the caller is allowed to see rather than counting
 * org-wide: the grid is fed by `listProjects`, which filters to the projects
 * this member can actually reach (ADR-0038), so counting across the whole
 * organization would put a row count against projects the caller was never
 * shown — and hand back the size of the tenant's estate to someone scoped to
 * one project. Returns a plain id → count map; projects with no documents are
 * simply absent.
 *
 * `hiddenFolderIds` are the folders the viewer may not read in any of those
 * projects (`getHiddenFolderIds`; folder ids are unique, so one list serves
 * all). Their documents are left out as `listProjectDocuments` leaves them out:
 * a number on the grid that counts a file the viewer cannot see tells them it
 * exists.
 */
export async function countDocumentsByProject(
  organizationId: string,
  projectIds: string[],
  hiddenFolderIds: readonly string[] | undefined,
  /** Whose count: a held file moves the number for its uploader and its reviewers only (ADR-0086). */
  reader: DocumentReader,
): Promise<Record<string, number>> {
  if (projectIds.length === 0) return {}
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ projectId: documents.projectId, total: count() })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.projectId, projectIds),
          // Same reason as `listProjectDocuments`: the grid's number must be
          // the count of what the project list shows, and the two must agree by
          // asking the same question rather than by both happening to exclude
          // the other shelves.
          eq(documents.scope, 'project'),
          ...outsideHiddenFolders(hiddenFolderIds),
          documentVisibleTo(reader),
        ),
      )
      .groupBy(documents.projectId),
  )
  return Object.fromEntries(rows.map((row) => [row.projectId, Number(row.total)]))
}
