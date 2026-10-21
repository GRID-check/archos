/**
 * The root sort's browser driver: a run is split into bounded requests, a
 * chunk that fails is reported and the run goes on, and every response is
 * parsed against the contract rather than cast.
 */
import { describe, expect, it, vi } from 'vitest'
import { applyFolderMoves, chunk, planRootSort, rootSortPath, type RootSortFetch } from './root-sort-client'
import { MAX_FOLDER_MOVES, ROOT_SORT_CHUNK } from './root-sort-types'

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ids = (count: number) => Array.from({ length: count }, (_, index) => `d${index}`)

describe('rootSortPath', () => {
  it('names the shelf', () => {
    expect(rootSortPath({ kind: 'project', projectId: 'p1' })).toBe('/api/projects/p1/root-sort')
    expect(rootSortPath({ kind: 'office_shelf' })).toBe('/api/office-shelf/root-sort')
  })
})

describe('chunk', () => {
  it('splits without losing or repeating an item', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('planRootSort', () => {
  it('judges every document a chunk at a time and reports a failed chunk', async () => {
    const run = vi.fn<RootSortFetch>(async (_path, init) => {
      const { documentIds } = JSON.parse(String(init?.body)) as { documentIds: string[] }
      if (documentIds.includes(`d${ROOT_SORT_CHUNK}`)) return respond(502, { error: 'backend down' })
      return respond(200, {
        placements: documentIds.map((documentId) => ({
          documentId,
          folderId: 'f1',
          newFolderPath: null,
          reason: 'Passt.',
          confidence: 0.8,
        })),
        error: null,
        traceId: null,
      })
    })
    const progress: number[] = []
    const result = await planRootSort(
      { kind: 'project', projectId: 'p1' },
      ids(ROOT_SORT_CHUNK * 2 + 5),
      (step) => progress.push(step.done),
      run
    )
    expect(run).toHaveBeenCalledTimes(3)
    expect(result.placements).toHaveLength(ROOT_SORT_CHUNK + 5)
    expect(result.failedDocumentIds).toHaveLength(ROOT_SORT_CHUNK)
    expect(result.error).toBe('backend down')
    expect(progress.at(-1)).toBe(ROOT_SORT_CHUNK * 2 + 5)
  })
})

describe('applyFolderMoves', () => {
  it('applies every move in bounded requests and reports what was refused', async () => {
    const run = vi.fn<RootSortFetch>(async (_path, init) => {
      const { moves } = JSON.parse(String(init?.body)) as { moves: Array<{ documentId: string }> }
      return respond(200, {
        results: moves.map(({ documentId }) => ({
          documentId,
          ok: documentId !== 'd3',
          error: documentId === 'd3' ? 'Folder not found in this project.' : null,
        })),
      })
    })
    const moves = ids(MAX_FOLDER_MOVES + 1).map((documentId) => ({ documentId, folderId: null }))
    const result = await applyFolderMoves(moves, () => {}, run)
    expect(run).toHaveBeenCalledTimes(2)
    expect(result.moved).toHaveLength(MAX_FOLDER_MOVES)
    expect(result.failed).toEqual([{ documentId: 'd3', error: 'Folder not found in this project.' }])
  })

  it('reports every move of a request that failed whole', async () => {
    const run: RootSortFetch = async () => respond(403, { error: 'Forbidden' })
    const result = await applyFolderMoves([{ documentId: 'd1', folderId: null }], () => {}, run)
    expect(result).toEqual({ moved: [], failed: [{ documentId: 'd1', error: 'Forbidden' }] })
  })
})
