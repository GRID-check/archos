import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SEARCH_FIXTURE_DOCUMENTS, SEARCH_FIXTURE_RESPONSE } from '@/app/dev/_fixtures/search'
import type { SearchBody, SearchResponse } from '@/lib/search/search-wire'
import { useSearchResults } from './use-search-results'

const postSearch = vi.fn<(scope: unknown, body: SearchBody) => Promise<SearchResponse>>()
vi.mock('../lib/search-client', () => ({ postSearch: (scope: unknown, body: SearchBody) => postSearch(scope, body) }))

const SCOPE = { scope: 'office' as const }
const BODY: SearchBody = { kinds: ['document'] }

const FIRST: SearchResponse = {
  ...SEARCH_FIXTURE_RESPONSE,
  sections: { document: { hits: SEARCH_FIXTURE_DOCUMENTS.slice(0, 3), total: 6, totalIsLowerBound: false, nextCursor: 'c2' } },
}

function page(hits: typeof SEARCH_FIXTURE_DOCUMENTS, nextCursor: string | null): SearchResponse {
  return { ...FIRST, sections: { document: { hits, total: 6, totalIsLowerBound: false, nextCursor } } }
}

const ids = (hits: { id: string }[] | undefined): string[] => (hits ?? []).map((hit) => hit.id)

async function settled() {
  const hook = renderHook(() => useSearchResults(SCOPE, BODY))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

describe('a section’s further pages', () => {
  beforeEach(() => {
    postSearch.mockReset()
    postSearch.mockImplementation(async (_scope, body) => (body.cursor ? page(SEARCH_FIXTURE_DOCUMENTS.slice(3, 6), null) : FIRST))
  })

  it('asks for one cursor once, however often the end of the list is reached before the page lands', async () => {
    const { result } = await settled()
    // The observer and a click in the same frame: both read the section before the re-render.
    const loadMore = result.current.loadMore
    act(() => {
      loadMore('document')
      loadMore('document')
      loadMore('document')
    })
    await waitFor(() => expect(result.current.sections.document?.loadingMore).toBe(false))
    expect(postSearch.mock.calls.filter(([, body]) => body.cursor === 'c2')).toHaveLength(1)
    expect(ids(result.current.sections.document?.hits)).toEqual(ids(SEARCH_FIXTURE_DOCUMENTS.slice(0, 6)))
  })

  it('stops at a page that hands back the cursor it was asked with, and shows each document once', async () => {
    // The capture harness answered every question with the first page: the
    // same hits and the same cursor, so the register appended page one again
    // and asked for it again, three times over.
    postSearch.mockImplementation(async () => FIRST)
    const { result } = await settled()
    await act(async () => result.current.loadMore('document'))
    await waitFor(() => expect(result.current.sections.document?.loadingMore).toBe(false))
    expect(ids(result.current.sections.document?.hits)).toEqual(ids(FIRST.sections.document?.hits))
    expect(result.current.sections.document?.nextCursor).toBeNull()
    await act(async () => result.current.loadMore('document'))
    expect(postSearch).toHaveBeenCalledTimes(2)
  })

  it('drops a document a later page repeats (a row moved between pages while they were read)', async () => {
    const overlap = [SEARCH_FIXTURE_DOCUMENTS[2], ...SEARCH_FIXTURE_DOCUMENTS.slice(3, 5)]
    postSearch.mockImplementation(async (_scope, body) => (body.cursor ? page(overlap, null) : FIRST))
    const { result } = await settled()
    await act(async () => result.current.loadMore('document'))
    await waitFor(() => expect(result.current.sections.document?.loadingMore).toBe(false))
    expect(ids(result.current.sections.document?.hits)).toEqual(ids(SEARCH_FIXTURE_DOCUMENTS.slice(0, 5)))
  })
})
