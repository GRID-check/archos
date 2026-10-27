/**
 * The keyset cursors of a document listing — where the next page starts.
 *
 * Two kinds. The LISTING cursor below is the shelf drain's (`created_at DESC,
 * id ASC`, the request without level parameters). The LEVEL cursor further
 * down is a folder level's, read in the order the reader chose (ADR-0102).
 *
 * A listing is ordered `created_at DESC, id ASC` (newest first, the id breaking
 * the ties a batch import produces). The cursor is the last row's position in
 * that order, and the next page is every row strictly after it. Unlike an
 * offset, it neither skips nor repeats a row when an upload lands between two
 * page reads.
 *
 * `createdAt` is carried as the column's own text at MICROSECOND precision, in
 * UTC, and never as a JS `Date`. Postgres stores microseconds and a `Date`
 * holds milliseconds, so a cursor built from the `Date` on the row sits up to
 * 999µs before the row it came from: the comparison `created_at < cursor` then
 * re-serves that row, and a tie inside the lost microseconds silently drops a
 * neighbour. The repository reads the text with `to_char(... 'US')` and
 * compares against `(text)::timestamp AT TIME ZONE 'UTC'`, which round-trips
 * exactly.
 *
 * Opaque on the wire (base64url JSON) so no client parses it, and validated on
 * the way back in, so a hand-edited cursor is a 400 rather than a query with a
 * value nobody checked.
 */

import { z } from 'zod'

/** One position in the `created_at DESC, id ASC` order. */
export interface DocumentListCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffff`, UTC, as `to_char` wrote it. */
  createdAt: string
  id: string
}

/** The shape `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')` writes. */
const MICROSECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/

/** The `to_char` pattern that produces {@link DocumentListCursor.createdAt}. */
export const CURSOR_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US'

const cursorSchema = z.object({
  t: z.string().regex(MICROSECOND_UTC),
  i: z.guid(),
})

/** Longest cursor the routes accept; a real one is well under 100 characters. */
export const DOCUMENT_LIST_CURSOR_MAX_LENGTH = 200

export function encodeDocumentListCursor(cursor: DocumentListCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt, i: cursor.id }), 'utf8').toString('base64url')
}

/** The cursor, or `null` for anything this module did not write. */
export function decodeDocumentListCursor(encoded: string): DocumentListCursor | null {
  if (encoded.length === 0 || encoded.length > DOCUMENT_LIST_CURSOR_MAX_LENGTH) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const result = cursorSchema.safeParse(parsed)
  if (!result.success) return null
  return { createdAt: result.data.t, id: result.data.i }
}

/**
 * The orders a folder level can be read in (`?sort=`, ADR-0102). `added` is
 * `created_at`, `name` the shown name (`coalesce(display_name, filename)`)
 * case-folded, `size` the byte count with an unknown size as the smallest.
 */
export const DOCUMENT_LEVEL_SORTS = ['added', 'name', 'size'] as const
export type DocumentLevelSort = (typeof DOCUMENT_LEVEL_SORTS)[number]

export const DOCUMENT_LEVEL_DIRECTIONS = ['asc', 'desc'] as const
export type DocumentLevelDirection = (typeof DOCUMENT_LEVEL_DIRECTIONS)[number]

/**
 * One position in a level's order: the sort and direction it belongs to, the
 * last row's sort key as Postgres wrote it, and its id (the tiebreak, always
 * ascending).
 *
 * The key is TEXT whatever the sort, read off the row by the same expression
 * the query orders by (`levelCursorValueColumn` in `./repository`): a name
 * case-folded by JavaScript and one case-folded by Postgres can disagree, and a
 * cursor that disagrees with the ORDER BY skips or repeats rows. For `added` it
 * is the microsecond UTC text described at the top of this module.
 *
 * The sort and direction travel in the cursor so a cursor read under one order
 * is refused under another (`documentListOptions`), instead of starting the
 * next page at a position that means nothing in it.
 */
export interface DocumentLevelCursor {
  sort: DocumentLevelSort
  dir: DocumentLevelDirection
  value: string
  id: string
}

/** A size key: `coalesce(file_size, -1)::text`. */
const INTEGER_TEXT = /^-?\d{1,12}$/

/** Longest sort key a level cursor carries; a name is at most a few hundred characters. */
const LEVEL_CURSOR_VALUE_MAX_LENGTH = 1024

/** Longest cursor the routes accept: a level cursor carries a name, base64url-encoded. */
export const DOCUMENT_LEVEL_CURSOR_MAX_LENGTH = 6000

const levelCursorSchema = z
  .object({
    s: z.enum(DOCUMENT_LEVEL_SORTS),
    d: z.enum(DOCUMENT_LEVEL_DIRECTIONS),
    v: z.string().max(LEVEL_CURSOR_VALUE_MAX_LENGTH),
    i: z.guid(),
  })
  .refine(({ s, v }) => (s === 'added' ? MICROSECOND_UTC.test(v) : s === 'size' ? INTEGER_TEXT.test(v) : true))

export function encodeDocumentLevelCursor(cursor: DocumentLevelCursor): string {
  return Buffer.from(
    JSON.stringify({ s: cursor.sort, d: cursor.dir, v: cursor.value, i: cursor.id }),
    'utf8',
  ).toString('base64url')
}

/** The level cursor, or `null` for anything this module did not write as one (a listing cursor included). */
export function decodeDocumentLevelCursor(encoded: string): DocumentLevelCursor | null {
  if (encoded.length === 0 || encoded.length > DOCUMENT_LEVEL_CURSOR_MAX_LENGTH) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const result = levelCursorSchema.safeParse(parsed)
  if (!result.success) return null
  return { sort: result.data.s, dir: result.data.d, value: result.data.v, id: result.data.i }
}

/**
 * The query-string field for a route that takes a cursor: optional, bounded,
 * and refused with a 400 when it does not decode as either kind. Which kind the
 * request needed is `documentListOptions`' question: a listing cursor on a
 * level read, or the other way round, is refused there.
 */
export const documentListCursorParam = z
  .string()
  .max(DOCUMENT_LEVEL_CURSOR_MAX_LENGTH)
  .refine(
    (value) => decodeDocumentListCursor(value) !== null || decodeDocumentLevelCursor(value) !== null,
    { message: 'Invalid cursor' },
  )
  .optional()
