/**
 * How one shelf's listing reaches the screen.
 *
 * A big corpus is twenty sequential pages. These pin what the reader sees
 * while they arrive: the first page at once, the rest appended behind it, the
 * server's seeded page never read twice, and a reload of the listing already
 * on screen swapped in whole, without a skeleton.
 */

import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import type { DocumentWireRow } from '../lib/file-item'
import { useFileListing } from './use-file-listing'

const OPTIONS = {
  endpoints: { list: '/api/documents', listParams: { projectId: 'proj-1' } },
  agentAuthoredOnly: false,
  includeArchived: false,
}

const row = (id: string): DocumentWireRow => ({
  id,
  filename: `${id}.pdf`,
  displayName: null,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-14T09:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
})

/** A response held until the test lets it go. */
function gate() {
  let release: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { opened, open: () => release() }
}

const ids = (files: readonly { id: string }[]) => files.map((file) => file.id)

describe('useFileListing', () => {
  it('continues from the server cursor after a seeded first page, without asking for that page again', async () => {
    const cursors: Array<string | null> = []
    server.use(
      http.get('/api/documents', ({ request }) => {
        cursors.push(new URL(request.url).searchParams.get('cursor'))
        return HttpResponse.json({ documents: [row('b')], nextCursor: null })
      })
    )

    const { result } = renderHook(() =>
      useFileListing({ ...OPTIONS, initialFiles: [row('a')], initialNextCursor: 'page-2' })
    )

    // The seed is on screen at once, and nothing pretends it is the whole shelf.
    expect(ids(result.current.files)).toEqual(['a'])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.complete).toBe(false)

    await waitFor(() => expect(result.current.complete).toBe(true))
    expect(ids(result.current.files)).toEqual(['a', 'b'])
    expect(cursors).toEqual(['page-2'])
    expect(result.current.truncated).toBe(false)
  })

  it('reads nothing on mount when the seed is the whole shelf', async () => {
    let requests = 0
    server.use(
      http.get('/api/documents', () => {
        requests += 1
        return HttpResponse.json({ documents: [], nextCursor: null })
      })
    )

    const { result } = renderHook(() => useFileListing({ ...OPTIONS, initialFiles: [row('a')] }))

    expect(result.current.complete).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(0)
  })

  it('draws the first page while the next is still on its way', async () => {
    const second = gate()
    server.use(
      http.get('/api/documents', async ({ request }) => {
        if (!new URL(request.url).searchParams.get('cursor')) {
          return HttpResponse.json({ documents: [row('a')], nextCursor: 'page-2' })
        }
        await second.opened
        return HttpResponse.json({ documents: [row('b')], nextCursor: null })
      })
    )

    const { result } = renderHook(() => useFileListing(OPTIONS))
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => expect(ids(result.current.files)).toEqual(['a']))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.complete).toBe(false)

    second.open()
    await waitFor(() => expect(result.current.complete).toBe(true))
    expect(ids(result.current.files)).toEqual(['a', 'b'])
  })

  it('keeps the listing on screen while it is read again, and swaps the answer in whole', async () => {
    const answer = gate()
    server.use(
      http.get('/api/documents', async () => {
        await answer.opened
        return HttpResponse.json({ documents: [row('a'), row('c')], nextCursor: null })
      })
    )
    const { result } = renderHook(() => useFileListing({ ...OPTIONS, initialFiles: [row('a'), row('b')] }))

    // Not quiet, and still no skeleton: this is the listing already on screen.
    let reload: Promise<void> = Promise.resolve()
    act(() => {
      reload = result.current.load()
    })
    expect(result.current.isLoading).toBe(false)
    expect(ids(result.current.files)).toEqual(['a', 'b'])

    answer.open()
    await act(async () => {
      await reload
    })
    expect(ids(result.current.files)).toEqual(['a', 'c'])
    expect(result.current.isLoading).toBe(false)
  })

  it('treats a filter flip as another listing: a skeleton until its first page', async () => {
    server.use(
      http.get('/api/documents', ({ request }) => {
        const agentOnly = new URL(request.url).searchParams.get('authoredBy') === 'agent'
        return HttpResponse.json({ documents: [row(agentOnly ? 'report' : 'a')], nextCursor: null })
      })
    )
    const { result, rerender } = renderHook(
      ({ agentAuthoredOnly }: { agentAuthoredOnly: boolean }) =>
        useFileListing({ ...OPTIONS, agentAuthoredOnly, initialFiles: [row('a')] }),
      { initialProps: { agentAuthoredOnly: false } }
    )

    rerender({ agentAuthoredOnly: true })
    expect(result.current.isLoading).toBe(true)

    await waitFor(() => expect(ids(result.current.files)).toEqual(['report']))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.complete).toBe(true)
  })

  it('folds quiet reloads asked for while one is in flight into one more read', async () => {
    let requests = 0
    const first = gate()
    server.use(
      http.get('/api/documents', async () => {
        requests += 1
        if (requests === 1) await first.opened
        return HttpResponse.json({ documents: [row('a')], nextCursor: null })
      })
    )
    const { result } = renderHook(() => useFileListing({ ...OPTIONS, initialFiles: [row('a')] }))

    // An upload landing asks twice (bytes arrived, reading done); a batch asks per file.
    act(() => {
      result.current.reloadQuietly()
      result.current.reloadQuietly()
      result.current.reloadQuietly()
    })
    first.open()

    await waitFor(() => expect(requests).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(2)
  })
})
