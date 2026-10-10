/**
 * @vitest-environment node
 *
 * `findFassungCounterparts` resolves the file names a page's Fassung links
 * reference to documents. A page of a few hundred documents references more
 * names than one query carries; the names past the first batch were dropped,
 * and their links with them (an older Fassung shown as current, a count
 * wrong). Every name is looked up now, in bounded queries.
 *
 * The pg-proxy harness of `list-page.spec.ts`: a real query builder over a
 * driver that records the SQL instead of connecting.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

vi.mock('server-only', () => ({}))

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []

/** Answers each query with one row per name it asked for that ends in an even number. */
const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  const asked = params.filter((value): value is string => typeof value === 'string' && /^f\d+\.pdf$/.test(value))
  const rows = asked
    .filter((name) => Number(name.slice(1, -4)) % 2 === 0)
    .map((name) => [`id-${name}`, name, 'p1', null, '2026-01-01T00:00:00.000Z'])
  return { rows }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: (_scope: unknown, fn: () => unknown) => fn(),
  withOptionalTenant: (_scope: unknown, fn: () => unknown) => fn(),
  withPlatformAccess: (fn: () => unknown) => fn(),
}))

import { DOCUMENT_LIST_LIMIT, findFassungCounterparts } from './repository'
import { FILENAME_LOOKUP_MAX_NAMES } from './filename-lookup'
import { SCREENED_ONLY } from './document-reader'

const namesIn = (query: CapturedQuery): string[] =>
  query.params.filter((value): value is string => typeof value === 'string' && /^f\d+\.pdf$/.test(value))

beforeEach(() => {
  captured.length = 0
})

describe('findFassungCounterparts', () => {
  it('looks up every name, past the bound of one query, and returns what each batch found', async () => {
    const names = Array.from({ length: FILENAME_LOOKUP_MAX_NAMES * 2 + 50 }, (_, i) => `f${i}.pdf`)

    const rows = await findFassungCounterparts('org-1', 'proj_abc', names, SCREENED_ONLY)

    expect(captured).toHaveLength(3)
    expect(captured.flatMap(namesIn).sort()).toEqual([...names].sort())
    // A name in the last batch resolves like one in the first.
    expect(rows.map((row) => row.filename)).toContain(`f${FILENAME_LOOKUP_MAX_NAMES * 2 + 48}.pdf`)
    expect(rows).toHaveLength((FILENAME_LOOKUP_MAX_NAMES * 2 + 50) / 2)
  })

  it('keeps each query bounded: at most the lookup bound of names, and a row limit', async () => {
    const names = Array.from({ length: FILENAME_LOOKUP_MAX_NAMES * 3 }, (_, i) => `f${i}.pdf`)

    await findFassungCounterparts('org-1', 'proj_abc', names, SCREENED_ONLY)

    for (const query of captured) {
      expect(namesIn(query).length).toBeLessThanOrEqual(FILENAME_LOOKUP_MAX_NAMES)
      expect(query.sql).toMatch(/limit \$\d+$/i)
      expect(query.params.at(-1)).toBe(DOCUMENT_LIST_LIMIT)
    }
  })

  it('asks once for a name given twice, and not at all for no name', async () => {
    await findFassungCounterparts('org-1', 'proj_abc', ['f2.pdf', 'f2.pdf'], SCREENED_ONLY)
    expect(captured).toHaveLength(1)
    expect(namesIn(captured[0])).toEqual(['f2.pdf'])

    captured.length = 0
    expect(await findFassungCounterparts('org-1', 'proj_abc', [], SCREENED_ONLY)).toEqual([])
    expect(captured).toHaveLength(0)
  })
})
