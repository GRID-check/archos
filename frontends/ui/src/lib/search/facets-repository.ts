/**
 * The SQL the search projection writes and its staleness reads (ADR-0136). No
 * authorization here: the projection is derived and nobody reads it except
 * through the search's own query, which joins `documents` under the reader's
 * predicate (`./document-repository.ts`). The two reads of `documents` below
 * see every row on purpose and return ids and numbers to a job, never a name
 * to a person (`document-visibility.spec.ts` names them).
 */

import 'server-only'
import { and, asc, count, eq, getTableColumns, gt, inArray, isNull, lt, max, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  documents,
  documentSearchFacets,
  documentSearchShelves,
  type DocumentSearchShelfRow,
  type NewDocumentSearchFacetsRow,
} from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { shelfDocumentWhere, type DocumentShelf } from '@/lib/documents/shelf'

/** Rows one projection slice reads and writes. */
export const PROJECTION_PAGE_SIZE = 200

/** The key a shelf's sync state is stored under. */
export function shelfKey(shelf: DocumentShelf): string {
  return shelf.kind === 'project' ? `project:${shelf.projectId}` : 'office_shelf'
}

/** The shelf a stored key names, or null for one this build does not know. */
export function shelfOfKey(key: string): DocumentShelf | null {
  if (key === 'office_shelf') return { kind: 'office_shelf' }
  const match = /^project:([0-9a-f-]{36})$/.exec(key)
  return match ? { kind: 'project', projectId: match[1] } : null
}

/**
 * Write rows, each only when what it says changed: an unchanged fingerprint
 * costs no write, so a backstop refresh of a quiet shelf writes nothing.
 */
export async function upsertSearchFacets(organizationId: string, rows: readonly NewDocumentSearchFacetsRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const now = new Date()
  const values = rows.map((row) => ({ ...row, organizationId, syncedAt: now }))
  const written = await withTenant({ organizationId }, () =>
    getDb()
      .insert(documentSearchFacets)
      .values(values)
      .onConflictDoUpdate({
        target: documentSearchFacets.documentId,
        set: excludedColumns(),
        setWhere: sql`${documentSearchFacets.fingerprint} IS DISTINCT FROM excluded.fingerprint`,
      })
      .returning({ documentId: documentSearchFacets.documentId })
  )
  return written.length
}

/** `col = excluded.col` for every column a refresh replaces. */
function excludedColumns(): Record<string, SQL> {
  const set: Record<string, SQL> = {}
  for (const [key, column] of Object.entries(getTableColumns(documentSearchFacets))) {
    if (key === 'documentId' || key === 'organizationId') continue
    set[key] = sql.raw(`excluded."${column.name}"`)
  }
  return set
}

/** One document as the projector needs it: what joins it to the backend listing. */
export interface ProjectionDocument {
  id: string
  filename: string
  collectionName: string
  authoredBy: 'user' | 'agent'
  publishedVersionId: string | null
}

/**
 * One page of a shelf's documents for the projector, by id. Every row, held
 * ones included: a held document's row is harmless (every read joins the
 * reader's predicate) and is ready the moment its screening passes.
 */
export async function listShelfDocumentsForProjection(
  organizationId: string,
  shelf: DocumentShelf,
  afterId: string | null
): Promise<ProjectionDocument[]> {
  return withTenant({ organizationId }, () =>
    getDb()
      .select({
        id: documents.id,
        filename: documents.filename,
        collectionName: documents.collectionName,
        authoredBy: documents.authoredBy,
        publishedVersionId: documents.publishedVersionId,
      })
      .from(documents)
      .where(and(shelfDocumentWhere(shelf, organizationId), afterId ? gt(documents.id, afterId) : undefined))
      .orderBy(asc(documents.id))
      .limit(PROJECTION_PAGE_SIZE)
  ) as Promise<ProjectionDocument[]>
}

/**
 * What a shelf's projection is built from, as one string per shelf: how many
 * documents it holds and its newest change. Every row, held ones included,
 * because the projection covers them too. One aggregate for all `shelves`.
 */
export async function shelfSourceFingerprints(
  organizationId: string,
  shelves: readonly DocumentShelf[]
): Promise<Map<string, string>> {
  const projectIds = shelves.flatMap((shelf) => (shelf.kind === 'project' ? [shelf.projectId] : []))
  const officeShelf = shelves.some((shelf) => shelf.kind === 'office_shelf')
  if (projectIds.length === 0 && !officeShelf) return new Map()
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({
        scope: documents.scope,
        projectId: documents.projectId,
        documents: count(),
        newest: max(documents.updatedAt),
      })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          or(
            projectIds.length > 0 ? and(eq(documents.scope, 'project'), inArray(documents.projectId, projectIds)) : undefined,
            officeShelf ? eq(documents.scope, 'office_shelf') : undefined
          )
        )
      )
      .groupBy(documents.scope, documents.projectId)
  )
  const fingerprints = new Map<string, string>()
  for (const shelf of shelves) fingerprints.set(shelfKey(shelf), '0')
  for (const row of rows) {
    const key = row.scope === 'office_shelf' ? 'office_shelf' : `project:${row.projectId}`
    const newest = row.newest ? new Date(row.newest).toISOString() : '-'
    fingerprints.set(key, `${Number(row.documents)}@${newest}`)
  }
  return fingerprints
}

/** The stored sync state of `keys`. */
export async function readShelfSyncStates(organizationId: string, keys: readonly string[]): Promise<DocumentSearchShelfRow[]> {
  if (keys.length === 0) return []
  return withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(documentSearchShelves)
      .where(and(eq(documentSearchShelves.organizationId, organizationId), inArray(documentSearchShelves.shelfKey, [...keys])))
  )
}

/**
 * Claim the right to queue a shelf's refresh: true for exactly one caller per
 * `minIntervalMs`, however many searches find it stale at once.
 */
export async function claimShelfRefresh(organizationId: string, shelf: DocumentShelf, minIntervalMs: number): Promise<boolean> {
  const now = new Date()
  const claimed = await withTenant({ organizationId }, () =>
    getDb()
      .insert(documentSearchShelves)
      .values({
        organizationId,
        shelfKey: shelfKey(shelf),
        projectId: shelf.kind === 'project' ? shelf.projectId : null,
        refreshRequestedAt: now,
      })
      .onConflictDoUpdate({
        target: [documentSearchShelves.organizationId, documentSearchShelves.shelfKey],
        set: { refreshRequestedAt: now },
        setWhere: or(
          isNull(documentSearchShelves.refreshRequestedAt),
          lt(documentSearchShelves.refreshRequestedAt, new Date(now.getTime() - minIntervalMs))
        ),
      })
      .returning({ shelfKey: documentSearchShelves.shelfKey })
  )
  return claimed.length > 0
}

/** Record that a shelf's projection was refreshed from `sourceFingerprint`. */
export async function markShelfSynced(organizationId: string, shelf: DocumentShelf, sourceFingerprint: string): Promise<void> {
  const now = new Date()
  await withTenant({ organizationId }, () =>
    getDb()
      .insert(documentSearchShelves)
      .values({
        organizationId,
        shelfKey: shelfKey(shelf),
        projectId: shelf.kind === 'project' ? shelf.projectId : null,
        sourceFingerprint,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [documentSearchShelves.organizationId, documentSearchShelves.shelfKey],
        set: { sourceFingerprint, syncedAt: now },
      })
  )
}
