/**
 * The SQL the filing judgement reads. No authorization here; `./service` owns
 * it. Every list is bounded, and every read of `documents` states its reader
 * (`documentVisibleTo`, ADR-0086).
 */

import 'server-only'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, type Document } from '@/lib/db/schema/documents'
import { projectFolders } from '@/lib/db/schema/project-folders'
import { withTenant } from '@/lib/db/tenant-context'
import type { DocumentReader } from '@/lib/documents/document-reader'
import { shelfDocumentWhere, shelfFolderWhere, type DocumentShelf } from '@/lib/documents/shelf'
import { documentVisibleTo } from '@/lib/documents/visibility'

/** Most folder rows read across the office's other projects. */
export const MAX_CONVENTION_FOLDERS = 3000

/** Most filed documents read per shelf to learn which Dokumentart lands where. */
export const MAX_FILED_SAMPLE = 300

/** A living project folder of another project, with what its access list says. */
export interface OfficeFolderRow {
  id: string
  projectId: string
  parentId: string | null
  path: string
  description: string | null
  accessMode: 'inherit' | 'custom'
}

/** The living folders of these projects, for the office's conventions. */
export async function listProjectsFolders(
  organizationId: string,
  projectIds: readonly string[]
): Promise<OfficeFolderRow[]> {
  if (projectIds.length === 0) return []
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({
        id: projectFolders.id,
        projectId: projectFolders.projectId,
        parentId: projectFolders.parentId,
        path: projectFolders.path,
        description: projectFolders.description,
        accessMode: projectFolders.accessMode,
      })
      .from(projectFolders)
      .where(
        and(
          eq(projectFolders.organizationId, organizationId),
          eq(projectFolders.scope, 'project'),
          inArray(projectFolders.projectId, [...projectIds]),
          isNull(projectFolders.deletedAt)
        )
      )
      .orderBy(projectFolders.path)
      .limit(MAX_CONVENTION_FOLDERS)
  )
  return rows.flatMap((row) => (row.projectId ? [{ ...row, projectId: row.projectId }] : []))
}

/** Most described folders the agents' folder block reads, per shelf. */
export const MAX_DESCRIBED_FOLDERS = 120

/** A living folder somebody described, on a project's shelf or the Büroablage. */
export interface DescribedFolderRow {
  id: string
  scope: 'project' | 'office_shelf'
  path: string
  description: string
}

/**
 * The described, living folders of one project's shelf (when `projectId` is
 * given) and of the Büroablage, the shallowest first. Bounded per shelf by
 * {@link MAX_DESCRIBED_FOLDERS}. Access is the caller's to apply: a project
 * folder under an own list must not reach every colleague's chat.
 */
export async function listDescribedFolders(
  organizationId: string,
  projectId: string | null
): Promise<DescribedFolderRow[]> {
  const read = (where: ReturnType<typeof and>) =>
    withTenant({ organizationId }, () =>
      getDb()
        .select({
          id: projectFolders.id,
          scope: projectFolders.scope,
          path: projectFolders.path,
          description: projectFolders.description,
        })
        .from(projectFolders)
        .where(and(eq(projectFolders.organizationId, organizationId), isNull(projectFolders.deletedAt), isNotNull(projectFolders.description), where))
        .orderBy(projectFolders.path)
        .limit(MAX_DESCRIBED_FOLDERS)
    )
  const [project, officeShelf] = await Promise.all([
    projectId ? read(and(eq(projectFolders.scope, 'project'), eq(projectFolders.projectId, projectId))) : Promise.resolve([]),
    read(eq(projectFolders.scope, 'office_shelf')),
  ])
  return [...project, ...officeShelf].flatMap((row) => (row.description ? [{ ...row, description: row.description }] : []))
}

/**
 * The most recently filed documents of a shelf that sit in a folder, as
 * `reader` may see them, newest first: the sample the Dokumentart per folder is
 * learned from. Bounded by {@link MAX_FILED_SAMPLE}.
 */
export async function listFiledDocuments(
  organizationId: string,
  shelf: DocumentShelf,
  reader: DocumentReader
): Promise<Document[]> {
  return withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(documents)
      .where(
        and(
          shelfDocumentWhere(shelf, organizationId),
          isNotNull(documents.folderId),
          eq(documents.status, 'completed'),
          documentVisibleTo(reader)
        )
      )
      .orderBy(desc(documents.createdAt))
      .limit(MAX_FILED_SAMPLE)
  )
}

/**
 * The documents at a shelf's root (no folder), as `reader` may see them, by
 * name: what a root sort reads. Bounded by `limit`, which the caller sets one
 * above what it will judge to know whether the root holds more.
 */
export async function listRootDocuments(
  organizationId: string,
  shelf: DocumentShelf,
  reader: DocumentReader,
  limit: number
): Promise<Document[]> {
  return withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(documents)
      .where(and(shelfDocumentWhere(shelf, organizationId), isNull(documents.folderId), documentVisibleTo(reader)))
      .orderBy(documents.filename)
      .limit(limit)
  )
}

/** These documents, when they sit at the shelf's root and `reader` may see them. At most `ids.length`. */
export async function findRootDocuments(
  organizationId: string,
  shelf: DocumentShelf,
  reader: DocumentReader,
  ids: readonly string[]
): Promise<Document[]> {
  if (ids.length === 0) return []
  return withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(documents)
      .where(
        and(
          shelfDocumentWhere(shelf, organizationId),
          isNull(documents.folderId),
          inArray(documents.id, [...ids]),
          documentVisibleTo(reader)
        )
      )
      .limit(ids.length)
  )
}

/** Most folder paths a shelf is checked against before a new folder is proposed. */
export const MAX_SHELF_FOLDER_PATHS = 5000

/**
 * Every living folder path of a shelf, whoever may read it: what a proposed
 * new folder must not collide with. Paths only, and never returned to a
 * person; bounded by {@link MAX_SHELF_FOLDER_PATHS}.
 */
export async function listShelfFolderPaths(organizationId: string, shelf: DocumentShelf): Promise<string[]> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({ path: projectFolders.path })
      .from(projectFolders)
      .where(shelfFolderWhere(shelf, organizationId))
      .limit(MAX_SHELF_FOLDER_PATHS)
  )
  return rows.map((row) => row.path)
}

/**
 * The paths of the shelf's living folders among `ids`, by id. For a root sort's
 * running list of what it just placed: the ids come from its own placements,
 * which only ever name a folder its requester was shown, so this answers no
 * folder that person could not already see.
 */
export async function findShelfFolderPaths(
  organizationId: string,
  shelf: DocumentShelf,
  ids: readonly string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({ id: projectFolders.id, path: projectFolders.path })
      .from(projectFolders)
      .where(and(shelfFolderWhere(shelf, organizationId), inArray(projectFolders.id, [...ids])))
      .limit(ids.length)
  )
  return new Map(rows.map((row) => [row.id, row.path]))
}
