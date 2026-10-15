import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { FileItem } from '../file-types'
import { useDocumentMoves } from './use-document-moves'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { toast } from 'sonner'

const file = (id: string, folderId: string | null): FileItem => ({
  id,
  filename: `${id}.jpg`,
  displayName: null,
  fileSize: 1,
  contentType: 'image/jpeg',
  status: 'ready',
  folderId,
  createdAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
})

/** The hook over a list it can patch, the way the workspace holds one. */
function harness(initial: FileItem[]) {
  let rows = initial
  const setFiles = vi.fn((action: FileItem[] | ((prev: FileItem[]) => FileItem[])) => {
    rows = typeof action === 'function' ? action(rows) : action
  })
  const hook = renderHook(() => useDocumentMoves(rows, setFiles, []))
  return { hook, rows: () => rows }
}

describe('useDocumentMoves.moveMany', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('moves every picked document and says so once', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    const { hook, rows } = harness([file('a', null), file('b', null), file('c', null)])

    let moved = 0
    await act(async () => {
      moved = await hook.result.current.moveMany(['a', 'b'], 'site', 'Baustelle')
    })

    expect(moved).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/documents/a/folder',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ folderId: 'site' }) })
    )
    expect(rows().map((row) => [row.id, row.folderId])).toEqual([
      ['a', 'site'],
      ['b', 'site'],
      ['c', null],
    ])
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('puts back the ones that failed, and reports them separately', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/b/') ? { ok: false, status: 500 } : { ok: true, status: 200 }
    )
    const { hook, rows } = harness([file('a', null), file('b', 'old')])

    let moved = 0
    await act(async () => {
      moved = await hook.result.current.moveMany(['a', 'b'], 'site', 'Baustelle')
    })

    expect(moved).toBe(1)
    expect(rows().find((row) => row.id === 'b')?.folderId).toBe('old')
    expect(rows().find((row) => row.id === 'a')?.folderId).toBe('site')
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('puts back a document whose request never arrived', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const { hook, rows } = harness([file('a', 'old')])

    await act(async () => {
      await hook.result.current.moveMany(['a'], 'site', 'Baustelle')
    })

    expect(rows()[0]?.folderId).toBe('old')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('does not ask for a document that is already there', async () => {
    const { hook } = harness([file('a', 'site')])
    let moved = -1
    await act(async () => {
      moved = await hook.result.current.moveMany(['a'], 'site', 'Baustelle')
    })
    expect(moved).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps no more than a few requests in flight', async () => {
    let inFlight = 0
    let peak = 0
    fetchMock.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return { ok: true, status: 200 }
    })
    const rowsIn = Array.from({ length: 12 }, (_, index) => file(`d${index}`, null))
    const { hook } = harness(rowsIn)

    await act(async () => {
      await hook.result.current.moveMany(rowsIn.map((row) => row.id), 'site', 'Baustelle')
    })

    expect(fetchMock).toHaveBeenCalledTimes(12)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
