/**
 * The query a document listing accepts — shared by `GET /api/documents` and
 * `GET /api/archiv/documents`, because a shelf's listing is one thing
 * (ADR-0078) and the Files workspace builds the same URL for both.
 *
 * Two reads share the URL (ADR-0102):
 *
 * - The SHELF DRAIN, the request without level parameters: every document of
 *   the shelf, `created_at DESC, id ASC`, 500 a page, the listing cursor. Its
 *   readers (the surfaced documents, the knowledge panel, document roles, the
 *   project inventory, the Files workspace's own fallback) follow `nextCursor`
 *   to the end, and its answer is byte for byte what it was before levels
 *   existed.
 * - A LEVEL READ, any request naming `folderId`, `sort`, `dir`, `q`, `state` or
 *   `limit`: one folder level (or, without `folderId`, the shelf filtered by
 *   `q`), in the order asked for, `limit` a page (default
 *   {@link DOCUMENT_LEVEL_PAGE_SIZE}), with a level cursor.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import { DOCUMENT_AUTHORS, type DocumentAuthor } from './document-authors'
import { DOCUMENT_READ_FAMILIES, type DocumentReadFamily } from './document-status'
import {
  DOCUMENT_LEVEL_DIRECTIONS,
  DOCUMENT_LEVEL_SORTS,
  decodeDocumentLevelCursor,
  decodeDocumentListCursor,
  documentListCursorParam,
  type DocumentLevelCursor,
  type DocumentLevelDirection,
  type DocumentLevelSort,
  type DocumentListCursor,
} from './list-cursor'

/** Rows a level page carries when the request does not say (`?limit=`). */
export const DOCUMENT_LEVEL_PAGE_SIZE = 100

/** The bounds `?limit=` is clamped to; the upper one is the repository's own page cap. */
export const DOCUMENT_LEVEL_LIMIT_MIN = 1
export const DOCUMENT_LEVEL_LIMIT_MAX = 500

/** Longest `?q=`: a name search, not a document. */
export const DOCUMENT_LEVEL_QUERY_MAX_LENGTH = 200

/** `?state=readable,failed`: read-state families, comma-separated, each one of {@link DOCUMENT_READ_FAMILIES}. */
const STATE_LIST = new RegExp(`^(${DOCUMENT_READ_FAMILIES.join('|')})(,(${DOCUMENT_READ_FAMILIES.join('|')}))*$`)

export const documentListFilterSchema = z.object({
  /**
   * Narrow the listing to what one kind of author wrote — the parameter behind
   * the „Von Piloti" filter chip.
   *
   * Validated against `DOCUMENT_AUTHORS` rather than accepted as a free string,
   * so a value the column cannot hold is a 400 here instead of a silently empty
   * result the caller reads as "Piloti has written nothing". The enum widens
   * with the tuple, which is the point of the tuple.
   */
  authoredBy: z.enum(DOCUMENT_AUTHORS).optional(),
  /**
   * Include the documents somebody archived (ADR-0054).
   *
   * Absent means active only, which is what „archiviert" has to mean or the
   * gesture does nothing a reader can see. `'true'` and not a bare presence
   * check, so the parameter reads the same way in a log line as it does in the
   * URL the Files pane builds.
   */
  includeArchived: z.literal('true').optional(),
  /** Where this page starts: the previous page's `nextCursor`. A malformed one is a 400. */
  cursor: documentListCursorParam,
  /** The level: a folder id, or `root` for the documents filed in no folder. Absent with another level parameter: the whole shelf. */
  folderId: z.union([z.literal('root'), z.string().uuid()]).optional(),
  /** The order of a level read. Default `added`. */
  sort: z.enum(DOCUMENT_LEVEL_SORTS).optional(),
  /** Its direction. Default `asc` for `name`, `desc` otherwise. */
  dir: z.enum(DOCUMENT_LEVEL_DIRECTIONS).optional(),
  /** A case-insensitive substring of the document's file name or its rename. */
  q: z.string().max(DOCUMENT_LEVEL_QUERY_MAX_LENGTH).optional(),
  /** Read-state families to keep (`documentReadFamily`); absent keeps every one. */
  state: z.string().max(100).regex(STATE_LIST).optional(),
  /** Rows per page, clamped to 1..500. Not a number is a 400. */
  limit: z.coerce.number().int().optional(),
})

export type DocumentListFilter = z.infer<typeof documentListFilterSchema>

/** The filters a shelf summary takes: the two the server answers, so its counts match the listing they sit above. */
export const documentSummaryFilterSchema = documentListFilterSchema.pick({ authoredBy: true, includeArchived: true })

export type DocumentSummaryFilter = z.infer<typeof documentSummaryFilterSchema>

/** What a level read asks of the repository, parsed and checked. */
export interface DocumentLevelQuery {
  /** A folder id, `null` for the shelf root, `undefined` for the whole shelf (a search). */
  folderId?: string | null
  sort: DocumentLevelSort
  dir: DocumentLevelDirection
  /** Trimmed and non-empty, or absent. */
  q?: string
  /** Absent keeps every family. */
  states?: readonly DocumentReadFamily[]
  /** Already clamped to {@link DOCUMENT_LEVEL_LIMIT_MIN}..{@link DOCUMENT_LEVEL_LIMIT_MAX}. */
  limit: number
  cursor?: DocumentLevelCursor
}

/** The service options a parsed listing query stands for. */
export interface DocumentListOptions {
  authoredBy?: DocumentAuthor
  includeArchived: boolean
  /** The shelf drain's position; never set beside {@link level}. */
  cursor?: DocumentListCursor
  /** Present for a level read (see the module header). */
  level?: DocumentLevelQuery
}

/** The service options a parsed listing query stands for. A cursor of the wrong kind or order is a 400. */
export function documentListOptions(query: DocumentListFilter): DocumentListOptions {
  const base = { authoredBy: query.authoredBy, includeArchived: query.includeArchived === 'true' }
  const level = documentLevelQuery(query)
  if (level) return { ...base, level }
  if (!query.cursor) return { ...base, cursor: undefined }
  const cursor = decodeDocumentListCursor(query.cursor)
  // The schema let it through as a LEVEL cursor; read without level
  // parameters it would silently restart at the first page.
  if (!cursor) throw new BadRequestError('Invalid cursor: this cursor belongs to a level read')
  return { ...base, cursor }
}

/** Whether the request names any level parameter. */
function isLevelRead(query: DocumentListFilter): boolean {
  return (
    query.folderId !== undefined ||
    query.sort !== undefined ||
    query.dir !== undefined ||
    query.q !== undefined ||
    query.state !== undefined ||
    query.limit !== undefined
  )
}

/** The level read a query asks for, or `null` for the shelf drain. */
export function documentLevelQuery(query: DocumentListFilter): DocumentLevelQuery | null {
  if (!isLevelRead(query)) return null
  const sort = query.sort ?? 'added'
  const dir = query.dir ?? (sort === 'name' ? 'asc' : 'desc')
  const q = query.q?.trim() ?? ''
  return {
    folderId: query.folderId === undefined ? undefined : query.folderId === 'root' ? null : query.folderId,
    sort,
    dir,
    ...(q === '' ? {} : { q }),
    ...(query.state ? { states: [...new Set(query.state.split(','))] as DocumentReadFamily[] } : {}),
    limit: clampLevelLimit(query.limit),
    ...(query.cursor ? { cursor: levelCursorFor(query.cursor, sort, dir) } : {}),
  }
}

/** `?limit=` clamped, never refused: a client asking for 10 000 gets the cap, not an error. */
export function clampLevelLimit(limit: number | undefined): number {
  if (limit === undefined) return DOCUMENT_LEVEL_PAGE_SIZE
  return Math.min(Math.max(DOCUMENT_LEVEL_LIMIT_MIN, limit), DOCUMENT_LEVEL_LIMIT_MAX)
}

/** The level cursor, refused when it is a listing cursor or was read under another order. */
function levelCursorFor(encoded: string, sort: DocumentLevelSort, dir: DocumentLevelDirection): DocumentLevelCursor {
  const cursor = decodeDocumentLevelCursor(encoded)
  if (!cursor) throw new BadRequestError('Invalid cursor: this cursor belongs to the shelf listing')
  if (cursor.sort !== sort || cursor.dir !== dir) {
    throw new BadRequestError('Invalid cursor: it was read under another order')
  }
  return cursor
}
