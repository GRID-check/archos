/** Shelf reads: the shelf row, folder summary, failed tally and filename lookups. */

import 'server-only'
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { projectShelf, type DocumentShelf } from '../shelf'
import { documentAliasKey, documentNameKey, documentNameVariants } from '../name-match'
import { FILENAME_LOOKUP_MAX_NAMES } from '../filename-lookup'
import { declaredStatusesIn, type DocumentReadFamily } from '../document-status'
import { SHELF_SUMMARY_FAILED_LIMIT, SHELF_SUMMARY_FOLDER_LIMIT, type ShelfFolderTally, type ShelfSummary } from '../shelf-summary-types'
import { documents } from '@/lib/db/schema/documents'
import { DOCUMENT_LIST_LIMIT, documentListColumns, type DocumentListRow, listingWhere, type ListProjectDocumentsOptions } from './list'
import { type ShelfReadFilters } from './levels'
import { retryAllowedSql } from './quarantine-and-retry'

/**
 * One document of a shelf as a listing row, for a deep link to a document the
 * paged level has not loaded (`GET /api/documents/[id]`, ADR-0102). Archived
 * documents are found when `includeArchived` says so; the hold and the
 * hidden-folder rule are the listing's.
 */
export async function findShelfDocumentListRow(
  shelf: DocumentShelf,
  organizationId: string,
  documentId: string,
  filters: ShelfReadFilters,
): Promise<DocumentListRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(and(eq(documents.id, documentId), listingWhere(shelf, organizationId, filters)))
      .limit(1),
  )
  return row ?? null
}

// --- What Postgres can say about a whole shelf (ADR-0102) --------------------

/** `count(*)` of the rows in one read-state family, by the status vocabulary's own declaration. */
function familyCount(family: Exclude<DocumentReadFamily, 'reading'>): SQL<number> {
  return sql<number>`count(*) FILTER (WHERE ${inArray(sql`lower(${documents.status})`, declaredStatusesIn(family))})`
}

/** The ISO-8601 the browser compares `createdAt` with (`Date#toISOString`). */
const ISO_MILLISECOND_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'

/**
 * Per folder of a shelf (`null` is the root), the documents filed directly in
 * it, counted by read-state family, and the newest one's `created_at`: the
 * folder tiles and the folder brief, folded up the tree by the browser
 * (`foldTallies`). One aggregate over the listing's own WHERE, so it counts
 * exactly the rows a listing would show this reader, and no backend call:
 * the status is the stored one (rows still `pending` in Postgres are
 * reconciled by the upload sweep, or when a page holding them is read).
 *
 * Bounded by the number of folders ({@link SHELF_SUMMARY_FOLDER_LIMIT}). The
 * reading family is what is left of the total, so a status nobody declared is
 * counted as being read, as the browser counts it.
 */
export async function summarizeShelfFolders(
  shelf: DocumentShelf,
  organizationId: string,
  filters: ShelfReadFilters,
): Promise<ShelfFolderTally[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        folderId: documents.folderId,
        total: sql<number>`count(*)`,
        readable: familyCount('readable'),
        failed: familyCount('failed'),
        held: familyCount('held'),
        unindexed: familyCount('unindexed'),
        latest: sql<string | null>`to_char(max(${documents.createdAt}) AT TIME ZONE 'UTC', ${ISO_MILLISECOND_FORMAT})`,
      })
      .from(documents)
      .where(listingWhere(shelf, organizationId, filters))
      .groupBy(documents.folderId)
      .limit(SHELF_SUMMARY_FOLDER_LIMIT),
  )
  // Coerced at the boundary: `count(*)` is a bigint, which the driver hands back as text.
  return rows.map((row) => {
    const total = Number(row.total)
    const readable = Number(row.readable)
    const failed = Number(row.failed)
    const held = Number(row.held)
    const unindexed = Number(row.unindexed)
    return {
      folderId: row.folderId,
      total,
      readable,
      reading: Math.max(0, total - readable - failed - held - unindexed),
      failed,
      held,
      unindexed,
      latest: row.latest === null ? null : String(row.latest),
    }
  })
}

/**
 * The failed documents of a shelf, newest first, at most
 * {@link SHELF_SUMMARY_FAILED_LIMIT}: what „Alle erneut lesen“ sends back
 * through ingestion. One probe row past the limit says whether it was cut.
 *
 * Only the ones reading again may change ({@link retryAllowedSql}): a file that
 * failed for a lasting reason is counted in the tally and not sent back, so the
 * button counts what it will send.
 */
export async function listShelfFailedDocuments(
  shelf: DocumentShelf,
  organizationId: string,
  filters: ShelfReadFilters,
): Promise<Pick<ShelfSummary, 'failed' | 'failedTruncated'>> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: documents.id, folderId: documents.folderId })
      .from(documents)
      .where(
        and(
          listingWhere(shelf, organizationId, filters),
          inArray(sql`lower(${documents.status})`, declaredStatusesIn('failed')),
          retryAllowedSql(),
        ),
      )
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(SHELF_SUMMARY_FAILED_LIMIT + 1),
  )
  return {
    failed: rows.slice(0, SHELF_SUMMARY_FAILED_LIMIT).map((row) => ({ id: row.id, folderId: row.folderId })),
    failedTruncated: rows.length > SHELF_SUMMARY_FAILED_LIMIT,
  }
}

/**
 * Rows whose filename is one of `filenames` — in either Unicode form, and
 * case-insensitively, because every reader of the answer (the citation
 * resolver, the surfaced-documents index, the search join) compares names the
 * way a person does, and a model that spelled `Grundriss.PDF` still means the
 * row called `grundriss.pdf`. The exact list keeps the filename index in play
 * for the common spelling; the folded one catches the rest.
 *
 * At most {@link FILENAME_LOOKUP_MAX_NAMES} names; `undefined` for none, which
 * the callers turn into "ask nothing".
 */
export function filenameLookupWhere(filenames: readonly string[]): SQL | undefined {
  const bounded = [...new Set(filenames.map(documentNameKey).filter((name) => name.length > 0))].slice(
    0,
    FILENAME_LOOKUP_MAX_NAMES,
  )
  if (bounded.length === 0) return undefined
  const exact = [...new Set(bounded.flatMap(documentNameVariants))]
  const folded = [...new Set(bounded.flatMap((name) => documentNameVariants(documentAliasKey(name))))]
  return or(inArray(documents.filename, exact), inArray(sql`lower(${documents.filename})`, folded))
}

/**
 * The documents of a shelf named `filenames` — the rows a listing would show
 * (same shelf, same lifecycle rule), found by name rather than by paging.
 *
 * For the readers that need SPECIFIC documents: the semantic search's join and
 * the by-name resolve behind citations and surfaced-document cards. Reading the
 * first listing page for them dropped every hit past the newest 500 as if it
 * did not exist. Bounded by its input and by `DOCUMENT_LIST_LIMIT`.
 *
 * Folders do not enter into it: a document is unique per filename per
 * collection, so a name finds it wherever it is filed.
 */
export async function findDocumentsByFilenames(
  shelf: DocumentShelf,
  organizationId: string,
  filenames: readonly string[],
  {
    includeArchived = false,
    hiddenFolderIds,
    reader,
  }: Pick<ListProjectDocumentsOptions, 'includeArchived' | 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentListRow[]> {
  const byName = filenameLookupWhere(filenames)
  if (!byName) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(and(listingWhere(shelf, organizationId, { includeArchived, hiddenFolderIds, reader }), byName))
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(DOCUMENT_LIST_LIMIT),
  )
}

/** The project documents named `filenames` — see {@link findDocumentsByFilenames}. */
export function findProjectDocumentsByFilenames(
  projectId: string,
  organizationId: string,
  filenames: readonly string[],
  options: Pick<ListProjectDocumentsOptions, 'includeArchived' | 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentListRow[]> {
  return findDocumentsByFilenames(projectShelf(projectId), organizationId, filenames, options)
}
