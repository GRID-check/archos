import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@/test-utils'
import { HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { OFFICE_SHELF_SEARCH_SCOPE, projectSearchScope } from '../lib/file-shelf'
import { useFileSearch } from './use-file-search'
import { http } from 'msw'
import { documentSearchAnswer } from '@/test-utils/search-answers'

describe('useFileSearch', () => {
  let requests: Array<{ path: string; query: string; body: unknown }>

  beforeEach(() => {
    requests = []
    server.use(
      http.post('/api/search', async ({ request }) => {
        const url = new URL(request.url)
        requests.push({ path: url.pathname, query: url.search, body: await request.json() })
        return HttpResponse.json(documentSearchAnswer([]))
      })
    )
  })

  it('asks the one search for the documents of a project, the project as the scope', async () => {
    const { result } = renderHook(() => useFileSearch(projectSearchScope('proj-1')))
    act(() => result.current.setQuery('Brandschutz'))
    act(() => result.current.run())

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toEqual({
      path: '/api/search',
      query: '?projectId=proj-1',
      body: { text: 'Brandschutz', kinds: ['document'], facets: false },
    })
  })

  it('searches the Archiv by its scope, shelf-wide', async () => {
    const { result } = renderHook(() => useFileSearch(OFFICE_SHELF_SEARCH_SCOPE))
    act(() => result.current.setQuery('Brandschutz'))
    act(() => result.current.run())

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toEqual({
      path: '/api/search',
      query: '?scope=office_shelf',
      body: { text: 'Brandschutz', kinds: ['document'], facets: false },
    })
  })

  it('offers the substring filter alone without a scope', () => {
    const { result } = renderHook(() => useFileSearch())
    expect(result.current.canSearch).toBe(false)
    act(() => result.current.run())
    expect(requests).toEqual([])
  })

  it('drops semantic mode on any edit to the query', async () => {
    const { result } = renderHook(() => useFileSearch(OFFICE_SHELF_SEARCH_SCOPE))
    act(() => result.current.setQuery('a'))
    act(() => result.current.run())
    await waitFor(() => expect(result.current.semantic.active).toBe(true))
    act(() => result.current.setQuery('ab'))
    expect(result.current.semantic.active).toBe(false)
  })
})
