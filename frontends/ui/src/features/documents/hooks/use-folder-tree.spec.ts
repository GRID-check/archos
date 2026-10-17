import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import type { FileItem, FolderItem } from '../file-types'
import { useFolderTree } from './use-folder-tree'

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}))

const FOLDERS: FolderItem[] = [
  { id: 'f-1', name: 'Planung', parentId: null, path: 'Planung' },
  { id: 'f-2', name: 'Statik', parentId: 'f-1', path: 'Planung/Statik' },
]

/** One tree, two shelves: the hook only knows the URL it is handed. */
describe.each([
  ['a project', '/api/projects/proj-1/folders'],
  ['the Archiv', '/api/archiv/folders'],
])('useFolderTree over %s', (_name, foldersUrl) => {
  const reloadFiles = vi.fn().mockResolvedValue(undefined)
  const onSelectFolder = vi.fn()
  const calls: Array<{ method: string; path: string; body: unknown }> = []

  const render = (files: readonly FileItem[] = []) =>
    renderHook(() =>
      useFolderTree({ foldersUrl, files, selectedFolderId: null, onSelectFolder, reloadFiles })
    )

  const record = async (request: Request) => {
    const text = await request.text()
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : null,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    server.use(
      http.get(foldersUrl, () => HttpResponse.json({ folders: FOLDERS })),
      http.post(foldersUrl, async ({ request }) => {
        await record(request)
        return HttpResponse.json({ folder: { id: 'f-9', name: 'Neu', parentId: null, path: 'Neu' } }, { status: 201 })
      }),
      http.patch(`${foldersUrl}/:id`, async ({ request }) => {
        await record(request)
        return HttpResponse.json({ folder: { id: 'f-2', name: 'Statik 2', parentId: 'f-1', path: 'Planung/Statik 2' } })
      }),
      http.delete(`${foldersUrl}/:id`, async ({ request }) => {
        await record(request)
        return HttpResponse.json({ documentsMoved: 2, foldersMoved: 0 })
      })
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it('reads the tree from the shelf it was given', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toEqual(FOLDERS))
    expect(result.current.error).toBe(false)
  })

  it('re-reads behind the tree it already has: only the first read is a first load', async () => {
    const { result } = render()
    expect(result.current.isFirstLoad).toBe(true)
    await waitFor(() => expect(result.current.folders).toEqual(FOLDERS))
    expect(result.current.isFirstLoad).toBe(false)

    // A rename or a move re-reads the tree; the tiles on screen stay there.
    let reread: Promise<unknown> = Promise.resolve()
    act(() => {
      reread = result.current.load()
    })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.isFirstLoad).toBe(false)
    expect(result.current.folders).toEqual(FOLDERS)
    await act(async () => {
      await reread
    })
    expect(result.current.isLoading).toBe(false)
  })

  it('reports a failed read as an error with an empty tree', async () => {
    server.use(http.get(foldersUrl, () => HttpResponse.json({}, { status: 500 })))
    const { result } = render()
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.folders).toEqual([])
  })

  it('keeps the tree it has when a re-read fails, instead of emptying it', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toEqual(FOLDERS))

    server.use(http.get(foldersUrl, () => HttpResponse.json({}, { status: 503 })))
    await act(async () => {
      await result.current.load()
    })

    expect(result.current.folders).toEqual(FOLDERS)
    expect(result.current.error).toBe(false)
    expect(result.current.isLoading).toBe(false)
  })

  it('lets only the newest of two crossing reads commit', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toEqual(FOLDERS))

    // The first re-read is slow and answers with the tree before a folder was
    // made; the second answers with the folder. The older answer lands last.
    const NEU: FolderItem = { id: 'f-9', name: 'Neu', parentId: null, path: 'Neu' }
    let releaseOld: () => void = () => undefined
    const oldAnswered = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    let reads = 0
    server.use(
      http.get(foldersUrl, async () => {
        reads += 1
        if (reads === 1) {
          await oldAnswered
          return HttpResponse.json({ folders: FOLDERS })
        }
        return HttpResponse.json({ folders: [...FOLDERS, NEU] })
      })
    )

    let older: Promise<unknown> = Promise.resolve()
    act(() => {
      older = result.current.load()
    })
    await act(async () => {
      await result.current.load()
    })
    expect(result.current.folders).toEqual([...FOLDERS, NEU])

    releaseOld()
    await act(async () => {
      await older
    })
    expect(result.current.folders).toEqual([...FOLDERS, NEU])
    expect(result.current.isLoading).toBe(false)
  })

  it('creates a folder under the shelf', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    let ok = false
    await act(async () => {
      ok = await result.current.create('Neu')
    })

    expect(ok).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'POST', path: foldersUrl, body: { name: 'Neu' } })
    expect(result.current.folders.map((f) => f.id)).toContain('f-9')
  })

  it('moves a folder optimistically, re-reads for the paths, and names where it went', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    await act(async () => {
      await result.current.move('f-2', null)
    })

    expect(calls[0]).toMatchObject({ method: 'PATCH', path: `${foldersUrl}/f-2`, body: { parentId: null } })
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('Statik'),
      expect.objectContaining({ action: expect.objectContaining({ onClick: expect.any(Function) }) })
    )
  })

  it('puts a refused move back and says so', async () => {
    server.use(http.patch(`${foldersUrl}/:id`, () => HttpResponse.json({}, { status: 500 })))
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    await act(async () => {
      await result.current.move('f-2', null)
    })

    expect(result.current.folders.find((f) => f.id === 'f-2')?.parentId).toBe('f-1')
    expect(toastError).toHaveBeenCalled()
  })

  const taken = () =>
    HttpResponse.json(
      { error: 'A folder with this name already exists here.', code: 'BAD_REQUEST', details: { reason: 'folder-name-taken' } },
      { status: 400 }
    )

  it('says which name is in the way when a folder is moved next to its namesake, and reads the tree again', async () => {
    server.use(http.patch(`${foldersUrl}/:id`, taken))
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))
    const reads = vi.fn()
    server.use(http.get(foldersUrl, () => (reads(), HttpResponse.json({ folders: FOLDERS }))))

    await act(async () => {
      await result.current.move('f-2', null)
    })

    expect(result.current.folders.find((f) => f.id === 'f-2')?.parentId).toBe('f-1')
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/already has a folder named “Statik”/))
    await waitFor(() => expect(reads).toHaveBeenCalled())
  })

  it('says a taken name by name on a create and on a rename too', async () => {
    server.use(http.post(foldersUrl, taken), http.patch(`${foldersUrl}/:id`, taken))
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    await act(async () => {
      await result.current.create('Statik', 'f-1')
    })
    expect(toastError).toHaveBeenLastCalledWith('“Planung” already has a folder named “Statik”.')
    await act(async () => {
      await result.current.rename('f-2', 'Bestand')
    })
    expect(toastError).toHaveBeenLastCalledWith('“Planung” already has a folder named “Bestand”.')
  })

  it('says a folder only readable is why, not „please try again"', async () => {
    server.use(http.patch(`${foldersUrl}/:id`, () => HttpResponse.json({ error: 'Forbidden' }, { status: 403 })))
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    await act(async () => {
      await result.current.move('f-2', null)
    })
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/may only read/))
  })

  it('offers the move back, and holds live re-reads while a move is on the wire', async () => {
    let release: () => void = () => undefined
    let tree = FOLDERS
    server.use(
      http.get(foldersUrl, () => HttpResponse.json({ folders: tree })),
      http.patch(`${foldersUrl}/:id`, async ({ request }) => {
        await record(request)
        await new Promise<void>((resolve) => {
          release = resolve
        })
        tree = [FOLDERS[0], { ...FOLDERS[1], parentId: null, path: 'Statik' }]
        return HttpResponse.json({ folder: {} })
      })
    )
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    let moving: Promise<void> = Promise.resolve()
    act(() => {
      moving = result.current.move('f-2', null)
    })
    expect(result.current.isMoving()).toBe(true)
    await waitFor(() => expect(calls).toHaveLength(1))
    await act(async () => {
      release()
      await moving
    })
    expect(result.current.isMoving()).toBe(false)

    const [, options] = toastSuccess.mock.lastCall as [string, { action: { onClick: () => void } }]
    act(() => options.action.onClick())
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: `${foldersUrl}/f-2`, body: { parentId: 'f-1' } })
    await act(async () => {
      release()
    })
  })

  it('asks before deleting, and says the documents are re-filed rather than deleted', async () => {
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    const inside = { id: 'd-1', folderId: 'f-1' } as FileItem
    const { result } = render([inside])
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    let ok = false
    await act(async () => {
      ok = await result.current.remove('f-1')
    })

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Planung'))
    expect(ok).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: `${foldersUrl}/f-1` })
    expect(reloadFiles).toHaveBeenCalledWith(true)
  })

  it('deletes nothing when the reader declines', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false))
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    await act(async () => {
      await result.current.remove('f-1')
    })
    expect(calls).toEqual([])
  })
})

/** A project's shelf has a Papierkorb (ADR-0088): a delete moves the folder there, with its contents. */
describe('useFolderTree over a shelf with a Papierkorb', () => {
  const foldersUrl = '/api/projects/proj-1/folders'
  const binHref = '/app/projects/proj-1/files/bin'
  const reloadFiles = vi.fn().mockResolvedValue(undefined)
  const render = () =>
    renderHook(() =>
      useFolderTree({ foldersUrl, files: [], selectedFolderId: null, onSelectFolder: vi.fn(), reloadFiles, binHref })
    )

  beforeEach(() => {
    vi.clearAllMocks()
    server.use(http.get(foldersUrl, () => HttpResponse.json({ folders: FOLDERS })))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('asks about the bin, not about re-filing, and the toast leads to it with the purge date', async () => {
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    server.use(
      http.delete(`${foldersUrl}/:id`, () =>
        HttpResponse.json({ documentsBinned: 3, foldersBinned: 2, purgeAfter: '2026-10-20T03:00:00.000Z' })
      )
    )
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    let ok = false
    await act(async () => {
      ok = await result.current.remove('f-1')
    })

    expect(ok).toBe(true)
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Papierkorb|bin/))
    expect(confirm).not.toHaveBeenCalledWith(expect.stringMatching(/verschoben|move to/))
    const [message, options] = toastSuccess.mock.calls[0] as [string, { action?: { label: string } }]
    expect(message).toMatch(/2026/)
    expect(options.action?.label).toMatch(/Papierkorb|Bin/)
  })

  it('names a refusal for a subtree holding content the reader may not delete', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    server.use(
      http.delete(`${foldersUrl}/:id`, () =>
        HttpResponse.json(
          { error: 'This folder holds content you may not delete.', details: { reason: 'folder-contents-protected' } },
          { status: 403 }
        )
      )
    )
    const { result } = render()
    await waitFor(() => expect(result.current.folders).toHaveLength(2))

    await act(async () => {
      await result.current.remove('f-1')
    })

    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/nicht löschen dürfen|may not delete/))
    expect(reloadFiles).not.toHaveBeenCalled()
  })
})
