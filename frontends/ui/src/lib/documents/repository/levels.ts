/** Folder-level listing: one folder's children, sorted and paged by cursor. */

import 'server-only'
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { type DocumentShelf } from '../shelf'
import { type DocumentLevelCursor, type DocumentLevelSort } from '../list-cursor'
import type { DocumentLevelQuery } from '../list-query'
import { DOCUMENT_READ_FAMILIES, declaredStatusesIn, type DocumentReadFamily } from '../document-status'
import { documents } from '@/lib/db/schema/documents'
import { boundListLimit, cursorCreatedAtColumn, documentListColumns, type DocumentListRow, listingWhere, type ListProjectDocumentsOptions } from './list'

/** The filters every read of a shelf shares: what the listing's own WHERE takes. */
export type ShelfReadFilters = Pick<ListProjectDocumentsOptions, 'authoredBy' | 'includeArchived' | 'hiddenFolderIds' | 'reader'>

/** One page of a level read, and where the next one starts. */
export interface DocumentLevelPage {
  rows: DocumentListRow[]
  /** The position after the last row, or `null` when this page is the last. */
  nextCursor: DocumentLevelCursor | null
}

/**
 * The sort key of a level order, as SQL. The cursor's value is read off the
 * row by the same expression ({@link levelCursorValueColumn}) and compared
 * against it ({@link afterDocumentLevelCursor}), so the three cannot disagree
 * about where a row sits: a name case-folded by JavaScript and one case-folded
 * by Postgres need not be the same string.
 */
function levelSortKey(sort: DocumentLevelSort): SQL {
  switch (sort) {
    case 'added':
      return sql`${documents.createdAt}`
    case 'name':
      return sql`lower(coalesce(${documents.displayName}, ${documents.filename}))`
    case 'size':
      // An unknown size sorts as the smallest, never as NULL: a NULL key would
      // need its own arm in every cursor comparison.
      return sql`coalesce(${documents.fileSize}, -1)`
  }
}

/** The sort key as text, for the cursor; `added` at microsecond precision in UTC, like the listing cursor. */
function levelCursorValueColumn(sort: DocumentLevelSort): SQL<string> {
  switch (sort) {
    case 'added':
      return cursorCreatedAtColumn
    case 'name':
      return sql<string>`lower(coalesce(${documents.displayName}, ${documents.filename}))`
    case 'size':
      return sql<string>`coalesce(${documents.fileSize}, -1)::text`
  }
}

/** The cursor's text back as a value of the key's own type. */
function levelCursorBound(cursor: DocumentLevelCursor): SQL {
  switch (cursor.sort) {
    case 'added':
      return sql`(${cursor.value}::timestamp AT TIME ZONE 'UTC')`
    case 'name':
      return sql`${cursor.value}::text`
    case 'size':
      return sql`${cursor.value}::integer`
  }
}

/**
 * Rows strictly after `cursor` in its order: past the key in the cursor's
 * direction, or on the same key with a greater id. The id breaks ties
 * ascending in both directions, so `added DESC` is the drain's own
 * `created_at DESC, id ASC` and the listing index serves it as it stands.
 */
export function afterDocumentLevelCursor(cursor: DocumentLevelCursor): SQL {
  const key = levelSortKey(cursor.sort)
  const bound = levelCursorBound(cursor)
  const past = cursor.dir === 'asc' ? sql`${key} > ${bound}` : sql`${key} < ${bound}`
  return sql`(${past} OR (${key} = ${bound} AND ${documents.id} > ${cursor.id}::uuid))`
}

/**
 * Documents whose file name or rename contains `q`, both sides folded by
 * `fold_german` (migration 0188): case, either Unicode form (a name off a
 * Mac is decomposed), and ä ö ü ß as ae oe ue ss, so „Abgabepläne“ and
 * „Abgabeplaene“ find the same files, as the agent's file listing does
 * (`knowledge_layer/browse.py`, `fold`). `strpos` and not `LIKE`, so a `%` or
 * `_` in what the reader typed is a character, not a wildcard. Nothing for an
 * empty query.
 */
export function nameContains(q: string | undefined): SQL | undefined {
  const needle = q?.trim() ?? ''
  if (needle === '') return undefined
  return or(
    sql`strpos(fold_german(${documents.filename}), fold_german(${needle})) > 0`,
    sql`strpos(fold_german(coalesce(${documents.displayName}, '')), fold_german(${needle})) > 0`,
  )
}

/**
 * Documents in one of `states`, by the family their status belongs to
 * (`documentReadFamily`). `reading` is every status no other family declares,
 * the unknown ones included, exactly as the browser reads them. Nothing when
 * every family, or none, is asked for.
 */
export function readFamilyWhere(states: readonly DocumentReadFamily[] | undefined): SQL | undefined {
  const wanted = [...new Set(states ?? [])]
  if (wanted.length === 0 || wanted.length === DOCUMENT_READ_FAMILIES.length) return undefined
  const lowered = sql`lower(${documents.status})`
  const declaredElsewhere = DOCUMENT_READ_FAMILIES.filter((family) => family !== 'reading').flatMap(declaredStatusesIn)
  return or(
    ...wanted.map((family) =>
      family === 'reading' ? notInArray(lowered, declaredElsewhere) : inArray(lowered, declaredStatusesIn(family)),
    ),
  )
}

/** The level's own predicates: its folder, the name search, the families, the cursor. */
function levelWhere({ folderId, q, states, cursor }: DocumentLevelQuery): SQL[] {
  const where: SQL[] = []
  if (folderId !== undefined) where.push(folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId))
  const named = nameContains(q)
  if (named) where.push(named)
  const family = readFamilyWhere(states)
  if (family) where.push(family)
  if (cursor) where.push(afterDocumentLevelCursor(cursor))
  return where
}

/**
 * Split `limit + 1` fetched rows into the page and its next cursor (the probe
 * row answers "is there more" without a COUNT), coercing at the boundary.
 */
export function readDocumentLevelPage(
  fetched: Array<DocumentListRow & { cursorValue: string }>,
  level: Pick<DocumentLevelQuery, 'sort' | 'dir'>,
  limit: number,
): DocumentLevelPage {
  const bounded = boundListLimit(limit)
  const hasMore = fetched.length > bounded
  const page = hasMore ? fetched.slice(0, bounded) : fetched
  const rows = page.map(({ cursorValue: _cursor, ...row }) => ({
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }))
  const last = page.at(-1)
  return {
    rows,
    nextCursor:
      hasMore && last ? { sort: level.sort, dir: level.dir, value: String(last.cursorValue), id: last.id } : null,
  }
}

/**
 * One page of a folder LEVEL of a shelf, in the order the reader chose — what
 * the Files workspace reads instead of draining the shelf (ADR-0102). The
 * shelf, lifecycle, author, hidden-folder and hold predicates are the
 * listing's own (`listingWhere`); the level adds its folder, the name search,
 * the read-state families and the cursor.
 *
 * Bounded like every listing: `limit` is clamped to {@link DOCUMENT_LIST_LIMIT}
 * and one probe row says whether there is more. The composite indexes of
 * migration 0132 serve `added`; `name` and `size` sort the level's rows, which
 * the same indexes narrow to the folder first.
 */
export async function listDocumentLevelPage(
  shelf: DocumentShelf,
  organizationId: string,
  { level, ...filters }: ShelfReadFilters & { level: DocumentLevelQuery },
): Promise<DocumentLevelPage> {
  const db = getDb()
  const bounded = boundListLimit(level.limit)
  const key = levelSortKey(level.sort)
  const fetched = await withTenant({ organizationId }, () =>
    db
      .select({ ...documentListColumns, cursorValue: levelCursorValueColumn(level.sort) })
      .from(documents)
      .where(and(listingWhere(shelf, organizationId, filters), ...levelWhere(level)))
      .orderBy(level.dir === 'asc' ? asc(key) : desc(key), asc(documents.id))
      .limit(bounded + 1),
  )
  return readDocumentLevelPage(fetched, level, bounded)
}
