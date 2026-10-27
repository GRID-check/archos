/**
 * Deleting a saved search can be taken back: the row leaves the list at once,
 * the server hears of it only when the undo window closes, and an undo inside
 * the window never reaches the server at all.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/search/saved-search-client', () => ({
  listSavedSearches: vi.fn(),
  createSavedSearch: vi.fn(),
  updateSavedSearch: vi.fn(),
  deleteSavedSearch: vi.fn(),
}))

import { deleteSavedSearch, listSavedSearches, type SavedSearchView } from '@/lib/search/saved-search-client'
import { useSavedSearches } from './use-saved-searches'

const MINE: SavedSearchView = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Einreichpläne, aktuell',
  scope: {},
  query: { text: 'Einreichplan' },
  shared: false,
  ownedByMe: true,
  ownerName: null,
  createdAt: '2026-10-21T09:10:00.000Z',
}
const OTHER: SavedSearchView = { ...MINE, id: '22222222-2222-4222-8222-222222222222', name: 'Brandschutz' }
const UNDO_MS = 1000

async function loaded(options: Parameters<typeof useSavedSearches>[0] = {}) {
  const hook = renderHook(() => useSavedSearches({ undoMs: UNDO_MS, ...options }))
  await waitFor(() => expect(hook.result.current.items).toHaveLength(2))
  return hook
}

describe('useSavedSearches: delete with undo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listSavedSearches).mockResolvedValue([MINE, OTHER])
    vi.mocked(deleteSavedSearch).mockResolvedValue(undefined)
  })
  afterEach(() => vi.useRealTimers())

  it('takes the search out of the list at once and deletes it when the window closes', async () => {
    const { result } = await loaded()
    vi.useFakeTimers()
    act(() => result.current.remove(MINE))
    expect(result.current.items?.map((item) => item.id)).toEqual([OTHER.id])
    expect(deleteSavedSearch).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS)
    })
    expect(deleteSavedSearch).toHaveBeenCalledWith(MINE.id)
    expect(result.current.items?.map((item) => item.id)).toEqual([OTHER.id])
  })

  it('puts it back on undo, and the server never hears of the delete', async () => {
    const { result } = await loaded()
    vi.useFakeTimers()
    act(() => result.current.remove(MINE))
    act(() => result.current.undoRemove(MINE))
    expect(result.current.items?.map((item) => item.id)).toEqual([MINE.id, OTHER.id])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS * 2)
    })
    expect(deleteSavedSearch).not.toHaveBeenCalled()
  })

  it('brings it back and says so when the server refuses the delete', async () => {
    vi.mocked(deleteSavedSearch).mockRejectedValue(new Error('500'))
    const onRemoveFailed = vi.fn()
    const { result } = await loaded({ onRemoveFailed })
    vi.useFakeTimers()
    act(() => result.current.remove(MINE))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS)
    })
    expect(onRemoveFailed).toHaveBeenCalledTimes(1)
    expect(result.current.items?.map((item) => item.id)).toEqual([MINE.id, OTHER.id])
  })

  it('sends a delete still waiting when the list goes away, so leaving never brings it back', async () => {
    const { result, unmount } = await loaded()
    act(() => result.current.remove(MINE))
    unmount()
    expect(deleteSavedSearch).toHaveBeenCalledWith(MINE.id)
  })
})
