/** Tenancy, visibility, existence and id reads. */

import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { withTenant } from '@/lib/db/tenant-context'
import { documents, type Document } from '@/lib/db/schema/documents'
import type { ResourceVisibility } from '@/lib/db/schema/resource-shares'
import { documentVisibleTo, SCREENED_ONLY, type DocumentReader } from '../visibility'
import { outsideHiddenFolders } from './list'

/**
 * Tenancy probe for authorization — unscoped, like `findConversationTenancy`.
 * The caller decides whether an organization mismatch is a 404.
 *
 * Screened rows only (ADR-0086): this is the sharing registry's probe, and a
 * held file is shared, assigned or named in an inbox row by nobody, its
 * uploader and reviewers included, until its screening passes. Sharing it
 * would hand it to people the hold exists to keep it from.
 */
export async function findDocumentTenancy(
  documentId: string,
): Promise<Pick<
  Document,
  'organizationId' | 'projectId' | 'folderId' | 'visibility' | 'createdBy' | 'filename' | 'displayName'
> | null> {
  const db = getDb()
  const [row] = await db
    .select({
      organizationId: documents.organizationId,
      projectId: documents.projectId,
      folderId: documents.folderId,
      visibility: documents.visibility,
      createdBy: documents.createdBy,
      filename: documents.filename,
      displayName: documents.displayName,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId), documentVisibleTo(SCREENED_ONLY)))
    .limit(1)
  return row ?? null
}

export async function updateDocumentVisibilityInOrg(
  documentId: string,
  organizationId: string,
  visibility: ResourceVisibility,
  /** A transaction the caller holds, already in this organization's context. */
  executor?: DbExecutor,
): Promise<Document | null> {
  const write = (handle: DbExecutor) =>
    handle
      .update(documents)
      .set({ visibility, updatedAt: new Date() })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
      .returning()
  const [row] = executor ? await write(executor) : await withTenant({ organizationId }, () => write(getDb()))
  return row ?? null
}

/**
 * Every document id of a project, held ones included: the project-member
 * cleanup removes a leaver's grants on all of them (allowlisted in
 * `document-visibility.spec.ts`).
 */
export async function listDocumentIdsForProject(
  projectId: string,
  organizationId: string,
  limit = 5_000,
): Promise<string[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.organizationId, organizationId)))
      .limit(limit),
  )
  return rows.map((row) => row.id)
}

/** The statuses a read ended in failure at — the `failed` family of `DOCUMENT_STATUS_FACTS`. */
const READ_FAILED_STATUSES = ['failed'] as const

/**
 * The project's active documents whose read FAILED and that a model may name:
 * screened ones only (ADR-0086, {@link SCREENED_ONLY}) and none in a folder the
 * caller hides (ADR-0087). Newest first, bounded by `limit`.
 *
 * Read for the agent's `documents_unreadable:` block. Without it a file Piloti
 * could not read was indistinguishable from one that does not exist: it has no
 * summary row, so neither the inventory nor any tool lists it, and an answer
 * called it missing.
 */
export async function listUnreadableProjectDocuments(
  projectId: string,
  organizationId: string,
  hiddenFolderIds: readonly string[],
  limit: number,
): Promise<{ filename: string; displayName: string | null; folderId: string | null }[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({ filename: documents.filename, displayName: documents.displayName, folderId: documents.folderId })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          eq(documents.organizationId, organizationId),
          eq(documents.lifecycle, 'active'),
          inArray(documents.status, [...READ_FAILED_STATUSES]),
          ...outsideHiddenFolders(hiddenFolderIds),
          documentVisibleTo(SCREENED_ONLY),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(limit),
  )
}

/**
 * Which of `ids` exist, held ones included: the orphan sweep deletes the grants
 * of a document that is gone, and a held document is not gone (allowlisted in
 * `document-visibility.spec.ts`).
 */
export async function documentIdsExisting(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const db = getDb()
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.id, [...ids]))
  return new Set(rows.map((row) => row.id))
}

/**
 * Load a document by id scoped to an organization, as `reader` may see it: a
 * held row (ADR-0086) is `null` for a reader who may not see it, exactly as an
 * unknown id is. A session's item paths go through `findDocumentForSession`
 * (`./access`), which asks the reviewer rule for the rest.
 */
export async function findDocumentInOrg(
  documentId: string,
  organizationId: string,
  reader: DocumentReader,
): Promise<Document | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, documentId), eq(documents.organizationId, organizationId), documentVisibleTo(reader)),
      )
      .limit(1),
  )
  return row ?? null
}
