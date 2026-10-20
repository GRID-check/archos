/**
 * The SQL the filing judgement reads. No authorization here; `./service` owns
 * it. Every list is bounded, and every read of `documents` states its reader
 * (`documentVisibleTo`, ADR-0086).
 */

import 'server-only'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents, projectFolders, type Document } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import type { DocumentReader } from '@/lib/documents/document-reader'
import { shelfDocumentWhere, type DocumentShelf } from '@/lib/documents/shelf'
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
  scope: 'project' | 'archiv'
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
    read(eq(projectFolders.scope, 'archiv')),
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
