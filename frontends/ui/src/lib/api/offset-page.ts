/**
 * Lean pages for lists whose order is fixed and whose rows change rarely
 * (ADR-0131, rule 3): `limit` and an opaque `cursor`, answered with
 * `nextCursor` (null on the last page). The cursor is the offset of the next
 * row; a list that is sorted by something other than a stable key, or that
 * changes between calls, should page by key instead.
 */

import { z } from 'zod'
import { BadRequestError } from './errors'

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

/** `limit` and `cursor` as a list route's query reads them. */
export const pageQueryShape = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(`Default ${DEFAULT_PAGE_LIMIT}, max ${MAX_PAGE_LIMIT}.`),
  cursor: z.string().max(64).optional(),
}

export interface OffsetPage {
  limit: number
  offset: number
}

export interface PageOf<T> {
  items: T[]
  nextCursor: string | null
}

/** The window a query asks for; a malformed cursor is a 400, never the first page. */
export function offsetPageOf(query: { limit?: number; cursor?: string }): OffsetPage {
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT
  if (query.cursor === undefined || query.cursor === '') return { limit, offset: 0 }
  const offset = Number(query.cursor)
  if (!/^\d+$/.test(query.cursor) || !Number.isSafeInteger(offset)) {
    throw new BadRequestError('Invalid cursor: pass the nextCursor of the previous page.')
  }
  return { limit, offset }
}

/** The `nextCursor` after a window that was asked for `limit + 1` rows and got `fetched` of them. */
export function nextOffsetCursor(page: OffsetPage, fetched: number): string | null {
  return fetched > page.limit ? String(page.offset + page.limit) : null
}

/** One page of an already ordered list. */
export function pageOfList<T>(rows: readonly T[], page: OffsetPage): { rows: T[]; nextCursor: string | null } {
  return {
    rows: rows.slice(page.offset, page.offset + page.limit),
    nextCursor: nextOffsetCursor(page, rows.length - page.offset),
  }
}

/**
 * Every page of a list, for a client that needs all rows (a count, a filter).
 * `fetchPage` takes the cursor to ask for (null for the first page).
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor?: string | null }>
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | null = null
  do {
    const page: { items: T[]; nextCursor?: string | null } = await fetchPage(cursor)
    all.push(...page.items)
    cursor = page.nextCursor ?? null
  } while (cursor !== null)
  return all
}
