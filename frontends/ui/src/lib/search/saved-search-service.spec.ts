/**
 * @vitest-environment node
 */
/**
 * Saved searches: a person sees their own and the office's shared ones, and
 * changes only their own; a colleague's answers 404 like a missing one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./saved-search-repository', () => ({
  countOwnedSavedSearches: vi.fn(),
  deleteOwnSavedSearch: vi.fn(),
  insertSavedSearch: vi.fn(),
  listVisibleSavedSearches: vi.fn(),
  updateOwnSavedSearch: vi.fn(),
}))

import { BadRequestError, ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { SavedSearchRow } from '@/lib/db/schema'
import {
  countOwnedSavedSearches,
  deleteOwnSavedSearch,
  insertSavedSearch,
  listVisibleSavedSearches,
  updateOwnSavedSearch,
} from './saved-search-repository'
import { createSavedSearch, deleteSavedSearch, listSavedSearches, updateSavedSearch } from './saved-search-service'
import { SAVED_SEARCHES_PER_PERSON_MAX } from './saved-search-wire'

const lena = { organizationId: 'org-1', userId: 'user-lena' }

function row(overrides: Partial<SavedSearchRow> = {}): SavedSearchRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: 'org-1',
    ownerUserId: 'user-lena',
    name: 'Brandschutz',
    scope: {},
    query: { text: 'Brandschutzkonzept' },
    shared: false,
    createdAt: new Date('2026-10-20T08:00:00Z'),
    updatedAt: new Date('2026-10-20T08:00:00Z'),
    ...overrides,
  }
}

/** What drizzle throws for a unique violation: the driver's error on `cause`. */
function uniqueViolation(): Error {
  return new Error('Failed query', {
    cause: Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'saved_searches_owner_name_key' }),
  })
}

describe('saved searches', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists a page newest first, marks what the reader owns, and hands on a cursor when more exist', async () => {
    vi.mocked(listVisibleSavedSearches).mockResolvedValue([
      row(),
      row({ id: '22222222-2222-4222-8222-222222222222', ownerUserId: 'user-max', shared: true }),
      row({ id: '33333333-3333-4333-8333-333333333333' }),
    ])
    const page = await listSavedSearches(lena, { limit: 2 })
    expect(listVisibleSavedSearches).toHaveBeenCalledWith(lena, { limit: 2, offset: 0 })
    expect(page.savedSearches.map((s) => [s.ownedByMe, s.shared])).toEqual([
      [true, false],
      [false, true],
    ])
    expect(page.savedSearches[0]?.createdAt).toBe('2026-10-20T08:00:00.000Z')
    expect(page.nextCursor).toBe('2')
  })

  it('answers no cursor on the last page, and refuses a cursor it never gave', async () => {
    vi.mocked(listVisibleSavedSearches).mockResolvedValue([row()])
    expect((await listSavedSearches(lena, { cursor: '2' })).nextCursor).toBeNull()
    await expect(listSavedSearches(lena, { cursor: 'abc' })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('saves as the caller', async () => {
    vi.mocked(countOwnedSavedSearches).mockResolvedValue(0)
    vi.mocked(insertSavedSearch).mockResolvedValue(row({ shared: true }))
    const input = { name: 'Brandschutz', scope: {}, query: { text: 'Brandschutzkonzept' }, shared: true }
    const view = await createSavedSearch(lena, input)
    expect(insertSavedSearch).toHaveBeenCalledWith(lena, input)
    expect(view).toMatchObject({ name: 'Brandschutz', shared: true, ownedByMe: true })
  })

  it('answers 409 for a name the caller already uses', async () => {
    vi.mocked(countOwnedSavedSearches).mockResolvedValue(3)
    vi.mocked(insertSavedSearch).mockRejectedValue(uniqueViolation())
    await expect(createSavedSearch(lena, { name: 'Brandschutz', scope: {}, query: {}, shared: false })).rejects.toBeInstanceOf(
      ConflictError
    )
  })

  it('refuses one more than a person may keep, before writing', async () => {
    vi.mocked(countOwnedSavedSearches).mockResolvedValue(SAVED_SEARCHES_PER_PERSON_MAX)
    await expect(createSavedSearch(lena, { name: 'x', scope: {}, query: {}, shared: false })).rejects.toBeInstanceOf(
      UnprocessableError
    )
    expect(insertSavedSearch).not.toHaveBeenCalled()
  })

  it('renames or shares the caller’s own', async () => {
    vi.mocked(updateOwnSavedSearch).mockResolvedValue(row({ name: 'Neu', shared: true }))
    const view = await updateSavedSearch(lena, 'id-1', { name: 'Neu', shared: true })
    expect(updateOwnSavedSearch).toHaveBeenCalledWith(lena, 'id-1', { name: 'Neu', shared: true })
    expect(view).toMatchObject({ name: 'Neu', shared: true })
  })

  it('answers 404 for a colleague’s saved search, never 403', async () => {
    vi.mocked(updateOwnSavedSearch).mockResolvedValue(null)
    vi.mocked(deleteOwnSavedSearch).mockResolvedValue(false)
    await expect(updateSavedSearch(lena, 'id-max', { shared: false })).rejects.toBeInstanceOf(NotFoundError)
    await expect(deleteSavedSearch(lena, 'id-max')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('answers 409 for a rename onto a name the caller already uses', async () => {
    vi.mocked(updateOwnSavedSearch).mockRejectedValue(uniqueViolation())
    await expect(updateSavedSearch(lena, 'id-1', { name: 'Brandschutz' })).rejects.toBeInstanceOf(ConflictError)
  })

  it('deletes the caller’s own', async () => {
    vi.mocked(deleteOwnSavedSearch).mockResolvedValue(true)
    await expect(deleteSavedSearch(lena, 'id-1')).resolves.toBeUndefined()
    expect(deleteOwnSavedSearch).toHaveBeenCalledWith(lena, 'id-1')
  })
})
