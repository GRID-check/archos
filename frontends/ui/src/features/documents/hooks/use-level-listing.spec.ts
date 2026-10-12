/**
 * One folder level, page by page (ADR-0102).
 *
 * These pin what the reader sees: the first page of a level, later pages
 * appended behind it when asked for, a folder change starting over, a change
 * of order or search keeping the rows until the new answer lands, an answer
 * for a level the reader has already left dropped, and the server's seeded
 * page never read twice.
 */

import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import type { LevelPageRequest } from '@/lib/documents/level-client'
import type { DocumentWireRow } from '../lib/file-item'
import { useLevelListing } from './use-level-listing'

const row = (id: string, folderId: string | null = null): DocumentWireRow => ({
  id,
  filename: `${id}.pdf`,
  displayName: null,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'ready',
  folderId,
  createdAt: '2026-06-14T09:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
})

const request = (overrides: Partial<Omit<LevelPageRequest, 'limit'>> = {}): Omit<LevelPageRequest, 'limit'> => ({
  list: '/api/documents',
  listParams: { projectId: 'proj-1' },
  folderId: null,
  sort: 'added',
  dir: 'desc',
  ...overrides,
})

const ids = (files: readonly { id: string }[]) => files.map((file) => file.id)

/** A response held until the test lets it go. */
function gate() {
  let release: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { opened, open: () => release() }
}

describe('useLevelListing', () => {
  it('reads the first page of the level, and the next one when asked', async () => {
    const asked: URLSearchParams[] = []
    server.use(
      http.get('/api/documents', ({ request: incoming }) => {
        const params = new URL(incoming.url).searchParams
        asked.push(params)
        return params.get('cursor') === 'page-2'
          ? HttpResponse.json({ documents: [row('b')], nextCursor: null })
          : HttpResponse.json({ documents: [row('a')], nextCursor: 'page-2' })
      })
    )

    const { result } = renderHook(() => useLevelListing({ request: request(), resetKey: 'folder:root' }))

    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(ids(result.current.files)).toEqual(['a']))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.hasMore).toBe(true)
    expect(asked[0].get('folderId')).toBe('root')
    expect(asked[0].get('limit')).toBe('100')

    act(() => result.current.loadMore())
    await waitFor(() => expect(ids(result.current.files)).toEqual(['a', 'b']))
    expect(result.current.hasMore).toBe(false)
    expect(asked.map((params) => params.get('cursor'))).toEqual([null, 'page-2'])
  })

  it('asks for one further page at a time, however often the end of the list is reached', async () => {
    const page2 = gate()
    let further = 0
    server.use(
      http.get('/api/documents', async ({ request: incoming }) => {
        if (!new URL(incoming.url).searchParams.get('cursor')) {
          return HttpResponse.json({ documents: [row('a')], nextCursor: 'page-2' })
        }
        further += 1
        await page2.opened
        return HttpResponse.json({ documents: [row('b')], nextCursor: null })
      })
    )
    const { result } = renderHook(() => useLevelListing({ request: request(), resetKey: 'folder:root' }))
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    act(() => {
      result.current.loadMore()
      result.current.loadMore()
    })
    expect(result.current.isLoadingMore).toBe(true)
    page2.open()
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false))
    expect(further).toBe(1)
  })

  it('starts over, with the skeleton, when the reader walks into another folder', async () => {
    server.use(
      http.get('/api/documents', ({ request: incoming }) => {
        const folder = new URL(incoming.url).searchParams.get('folderId')
        return HttpResponse.json({ documents: [row(`in-${folder}`)], nextCursor: null })
      })
    )
    const { result, rerender } = renderHook(
      ({ folderId }: { folderId: string | null }) =>
        useLevelListing({ request: request({ folderId }), resetKey: `folder:${folderId ?? 'root'}` }),
      { initialProps: { folderId: null as string | null } }
    )
    await waitFor(() => expect(ids(result.current.files)).toEqual(['in-root']))

    rerender({ folderId: 'f1' })
    // The root's rows are not the folder's: they leave at once.
    expect(result.current.files).toEqual([])
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(ids(result.current.files)).toEqual(['in-f1']))
  })

  it('keeps the rows on screen while a new order is read, and swaps them in whole', async () => {
    const byName = gate()
    server.use(
      http.get('/api/documents', async ({ request: incoming }) => {
        const sort = new URL(incoming.url).searchParams.get('sort')
        if (sort === 'name') {
          await byName.opened
          return HttpResponse.json({ documents: [row('b'), row('a')], nextCursor: null })
        }
        return HttpResponse.json({ documents: [row('a'), row('b')], nextCursor: null })
      })
    )
    const { result, rerender } = renderHook(
      ({ sort }: { sort: 'added' | 'name' }) => useLevelListing({ request: request({ sort }), resetKey: 'folder:root' }),
      { initialProps: { sort: 'added' as 'added' | 'name' } }
    )
    await waitFor(() => expect(ids(result.current.files)).toEqual(['a', 'b']))

    rerender({ sort: 'name' })
    expect(ids(result.current.files)).toEqual(['a', 'b'])
    byName.open()
    await waitFor(() => expect(ids(result.current.files)).toEqual(['b', 'a']))
  })

  it('drops the answer for a level the reader has already left', async () => {
    const slowRoot = gate()
    server.use(
      http.get('/api/documents', async ({ request: incoming }) => {
        const folder = new URL(incoming.url).searchParams.get('folderId')
        if (folder === 'root') await slowRoot.opened
        return HttpResponse.json({ documents: [row(`in-${folder}`)], nextCursor: null })
      })
    )
    const { result, rerender } = renderHook(
      ({ folderId }: { folderId: string | null }) =>
        useLevelListing({ request: request({ folderId }), resetKey: `folder:${folderId ?? 'root'}` }),
      { initialProps: { folderId: null as string | null } }
    )

    rerender({ folderId: 'f1' })
    await waitFor(() => expect(ids(result.current.files)).toEqual(['in-f1']))
    slowRoot.open()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ids(result.current.files)).toEqual(['in-f1'])
  })

  it('continues a seeded first page from its cursor, without reading that page again', async () => {
    const cursors: Array<string | null> = []
    server.use(
      http.get('/api/documents', ({ request: incoming }) => {
        cursors.push(new URL(incoming.url).searchParams.get('cursor'))
        return HttpResponse.json({ documents: [row('b')], nextCursor: null })
      })
    )
    const { result } = renderHook(() =>
      useLevelListing({
        request: request(),
        resetKey: 'folder:root',
        initialPage: { rows: [row('a')], nextCursor: 'page-2' },
      })
    )

    expect(ids(result.current.files)).toEqual(['a'])
    expect(result.current.isLoading).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cursors).toEqual([])

    act(() => result.current.loadMore())
    await waitFor(() => expect(ids(result.current.files)).toEqual(['a', 'b']))
    expect(cursors).toEqual(['page-2'])
  })

  it('reloads quietly as many rows as are on screen, swapping them in without a skeleton', async () => {
    const limits: Array<string | null> = []
    let reloaded = false
    server.use(
      http.get('/api/documents', ({ request: incoming }) => {
        const params = new URL(incoming.url).searchParams
        limits.push(params.get('limit'))
        if (params.get('cursor')) return HttpResponse.json({ documents: [row('b')], nextCursor: 'page-3' })
        return HttpResponse.json({
          documents: reloaded ? [row('new'), row('a'), row('b')] : [row('a')],
          nextCursor: 'page-2',
        })
      })
    )
    const { result } = renderHook(() => useLevelListing({ request: request(), resetKey: 'folder:root', pageSize: 1 }))
    await waitFor(() => expect(ids(result.current.files)).toEqual(['a']))
    act(() => result.current.loadMore())
    await waitFor(() => expect(ids(result.current.files)).toEqual(['a', 'b']))

    reloaded = true
    let reload: Promise<void> = Promise.resolve()
    act(() => {
      reload = result.current.reload()
    })
    expect(result.current.isLoading).toBe(false)
    await act(() => reload)
    expect(ids(result.current.files)).toEqual(['new', 'a', 'b'])
    expect(limits.at(-1)).toBe('2')
  })

  it('reports a failed first page, and keeps the rows when only a further page fails', async () => {
    server.use(http.get('/api/documents', () => new HttpResponse(null, { status: 500 })))
    const failing = renderHook(() => useLevelListing({ request: request(), resetKey: 'folder:root' }))
    await waitFor(() => expect(failing.result.current.error).toBe(true))
    expect(failing.result.current.files).toEqual([])
    failing.unmount()

    server.use(
      http.get('/api/documents', ({ request: incoming }) =>
        new URL(incoming.url).searchParams.get('cursor')
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json({ documents: [row('a')], nextCursor: 'page-2' })
      )
    )
    const { result } = renderHook(() => useLevelListing({ request: request(), resetKey: 'folder:root' }))
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.moreError).toBe(true))
    expect(ids(result.current.files)).toEqual(['a'])
    expect(result.current.error).toBe(false)
  })

  it('reads nothing while there is no level to read', async () => {
    let requests = 0
    server.use(
      http.get('/api/documents', () => {
        requests += 1
        return HttpResponse.json({ documents: [], nextCursor: null })
      })
    )
    const { result } = renderHook(() => useLevelListing({ request: null, resetKey: 'folder:root' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(0)
    expect(result.current.isLoading).toBe(false)
  })
})
