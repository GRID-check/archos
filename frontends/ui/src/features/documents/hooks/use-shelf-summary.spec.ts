/**
 * The shelf summary a paged workspace folds its folder tiles and brief from
 * (ADR-0102): read once per shelf and filter, read again on demand, the
 * previous answer kept while a new one is on its way, and a failure said.
 */

import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { useShelfSummary } from './use-shelf-summary'

const summary = (total: number) => ({
  folders: [{ folderId: null, total, readable: total, reading: 0, failed: 0, held: 0, unindexed: 0, latest: null }],
  failed: [],
  failedTruncated: false,
})

describe('useShelfSummary', () => {
  it('reads the summary of the shelf it is pointed at, and again when asked', async () => {
    let total = 3
    let requests = 0
    server.use(
      http.get('/api/documents/summary', () => {
        requests += 1
        return HttpResponse.json(summary(total))
      })
    )
    const { result } = renderHook(() => useShelfSummary({ url: '/api/documents/summary?projectId=p1' }))
    await waitFor(() => expect(result.current.summary?.folders[0].total).toBe(3))

    total = 4
    await act(() => result.current.reload())
    expect(result.current.summary?.folders[0].total).toBe(4)
    expect(requests).toBe(2)
  })

  it('keeps the previous answer while the summary of other filters is read', async () => {
    server.use(
      http.get('/api/documents/summary', ({ request }) =>
        HttpResponse.json(summary(new URL(request.url).searchParams.has('includeArchived') ? 9 : 3))
      )
    )
    const { result, rerender } = renderHook(({ url }: { url: string }) => useShelfSummary({ url }), {
      initialProps: { url: '/api/documents/summary?projectId=p1' },
    })
    await waitFor(() => expect(result.current.summary?.folders[0].total).toBe(3))

    rerender({ url: '/api/documents/summary?projectId=p1&includeArchived=true' })
    expect(result.current.summary?.folders[0].total).toBe(3)
    await waitFor(() => expect(result.current.summary?.folders[0].total).toBe(9))
  })

  it('says when the summary could not be read', async () => {
    server.use(http.get('/api/documents/summary', () => new HttpResponse(null, { status: 500 })))
    const { result } = renderHook(() => useShelfSummary({ url: '/api/documents/summary?projectId=p1' }))
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.summary).toBeNull()
  })

  it('reads nothing without a shelf', async () => {
    let requests = 0
    server.use(
      http.get('/api/documents/summary', () => {
        requests += 1
        return HttpResponse.json(summary(1))
      })
    )
    renderHook(() => useShelfSummary({ url: null }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(0)
  })
})
