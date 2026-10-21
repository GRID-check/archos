import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyFolderMoves, ensureFolders } from '@/lib/filing/root-sort-client'
import { applyKeptMoves, leftoverIds } from './root-sort-run'

vi.mock('@/lib/filing/root-sort-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/filing/root-sort-client')>()),
  ensureFolders: vi.fn(),
  applyFolderMoves: vi.fn(),
  planRootSort: vi.fn(),
  proposeNewFolders: vi.fn(),
}))

const shelf = { kind: 'office_shelf' } as const
const ensureMock = vi.mocked(ensureFolders)
const moveMock = vi.mocked(applyFolderMoves)

describe('leftoverIds', () => {
  it('keeps the documents no folder fits and drops placed and failed ones', () => {
    const run = {
      placements: [
        { documentId: 'a', folderId: 'f1', newFolderPath: null, reason: '', confidence: 0.9 },
        { documentId: 'b', folderId: null, newFolderPath: 'Neu', reason: '', confidence: 0.7 },
      ],
      failedDocumentIds: ['d'],
      error: null,
    }
    expect(leftoverIds(['a', 'b', 'c', 'd'], run)).toEqual(['c'])
  })
})

describe('applyKeptMoves', () => {
  beforeEach(() => {
    ensureMock.mockReset()
    moveMock.mockReset()
  })

  it('creates the kept new folders once, then moves each file to the id it came back with', async () => {
    ensureMock.mockResolvedValue({ 'Neu/Unter': 'uuid-neu' })
    moveMock.mockImplementation(async (moves) => ({
      moved: moves.map((move) => move.documentId),
      failed: [],
    }))
    const result = await applyKeptMoves(
      shelf,
      {
        newFolderPaths: ['Neu/Unter'],
        moves: [
          { documentId: 'a', folderId: 'f1', newFolderPath: null },
          { documentId: 'b', folderId: null, newFolderPath: 'Neu/Unter' },
        ],
      },
      () => {}
    )
    expect(ensureMock).toHaveBeenCalledTimes(1)
    expect(ensureMock.mock.calls[0]?.[1]).toEqual(['Neu/Unter'])
    expect(moveMock.mock.calls[0]?.[0]).toEqual([
      { documentId: 'a', folderId: 'f1' },
      { documentId: 'b', folderId: 'uuid-neu' },
    ])
    expect(result).toEqual({ moved: ['a', 'b'], failed: [] })
  })

  it('reports a file whose new folder did not come back as failed, and moves nothing for it', async () => {
    ensureMock.mockResolvedValue({})
    moveMock.mockResolvedValue({ moved: [], failed: [] })
    const result = await applyKeptMoves(
      shelf,
      {
        newFolderPaths: ['Weg'],
        moves: [{ documentId: 'b', folderId: null, newFolderPath: 'Weg' }],
      },
      () => {}
    )
    expect(result.failed).toEqual([{ documentId: 'b', error: 'missingFolder' }])
    expect(moveMock).not.toHaveBeenCalled()
  })

  it('throws when the folders cannot be created, so nothing is moved', async () => {
    ensureMock.mockRejectedValue(new Error('down'))
    await expect(
      applyKeptMoves(
        shelf,
        {
          newFolderPaths: ['Weg'],
          moves: [{ documentId: 'b', folderId: null, newFolderPath: 'Weg' }],
        },
        () => {}
      )
    ).rejects.toThrow('down')
    expect(moveMock).not.toHaveBeenCalled()
  })
})
