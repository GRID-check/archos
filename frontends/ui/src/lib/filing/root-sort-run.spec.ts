/**
 * @vitest-environment node
 *
 * The server-owned root sort (ADR-0121): each slice reads where the run got to,
 * does one bounded step, and writes it back conditioned on the status it read;
 * what the person keeps is checked against the run; one run in work per shelf.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./root-sort', () => ({
  planRootChunk: vi.fn(),
  proposeRootFolders: vi.fn(),
  requireSortable: vi.fn(),
  scanRoot: vi.fn(),
  sortContextFor: vi.fn(),
}))
vi.mock('./root-sort-run-repository', () => ({
  findLatestRootSortRun: vi.fn(),
  findRootSortRun: vi.fn(),
  insertRootSortRun: vi.fn(),
  updateRootSortRun: vi.fn(),
}))
vi.mock('./repository', () => ({ findRootDocuments: vi.fn() }))
vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentsToFolders: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('./root-sort-announce', () => ({ announceRootSortRun: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({ ensureProjectFolderPaths: vi.fn() }))
vi.mock('@/lib/office-shelf/folder-service', () => ({ ensureOfficeShelfFolderPaths: vi.fn() }))

import { ConflictError, ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { RootSortRun } from '@/lib/db/schema'
import { moveDocumentsToFolders } from '@/lib/documents/move-to-folder'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import type { RootSortPayload } from '@/lib/jobs-queue/types'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { planRootChunk, proposeRootFolders, requireSortable, scanRoot, sortContextFor, type SortContext } from './root-sort'
import { keptMovesOf, runRootSortSlice, startRootSort } from './root-sort-run'
import { findRootSortRun, insertRootSortRun, updateRootSortRun } from './root-sort-run-repository'
import { announceRootSortRun } from './root-sort-announce'
import { ROOT_SORT_CHUNK } from './root-sort-types'

const SESSION = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const PAYLOAD: RootSortPayload = {
  runId: '00000000-0000-4000-8000-0000000000aa',
  requester: { userId: 'user-1', email: 'a@b.c', organizationMembershipId: 'm1', role: 'member', permissions: [] },
}
const ids = (count: number, prefix = 'd') => Array.from({ length: count }, (_, index) => `${prefix}${index}`)

function run(patch: Partial<RootSortRun> = {}): RootSortRun {
  return {
    id: PAYLOAD.runId,
    organizationId: 'org-1',
    scope: 'project',
    projectId: 'p1',
    requestedBy: 'user-1',
    status: 'judging',
    documentIds: [],
    cursor: 0,
    unreadable: 0,
    truncated: false,
    placements: [],
    failedDocumentIds: [],
    newFolders: [],
    keptMoves: [],
    movedDocumentIds: [],
    moveFailures: [],
    undoFailures: [],
    error: null,
    groupingError: null,
    createdAt: new Date('2026-10-21T12:00:00Z'),
    updatedAt: new Date('2026-10-21T12:00:00Z'),
    finishedAt: null,
    ...patch,
  }
}

/** What the slice wrote, and from which status. */
const written = () => vi.mocked(updateRootSortRun).mock.calls.map(([, , from, patch]) => ({ from, patch }))

const CONTEXT = { folders: { rows: [] }, inputs: [], space: {}, conventions: [] } as unknown as SortContext

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(sortContextFor).mockResolvedValue(CONTEXT)
  vi.mocked(requireSortable).mockResolvedValue()
  vi.mocked(updateRootSortRun).mockImplementation(async (_org, _id, _from, patch) => run(patch))
})

describe('runRootSortSlice', () => {
  it('judges three chunks a slice, records a failed chunk, and keeps going', async () => {
    const documentIds = ids(ROOT_SORT_CHUNK * 4)
    vi.mocked(findRootSortRun).mockResolvedValue(run({ documentIds }))
    vi.mocked(planRootChunk).mockImplementation(async (_session, _shelf, chunk) =>
      chunk.includes(`d${ROOT_SORT_CHUNK}`)
        ? { placements: [], error: 'backend_502', traceId: null }
        : {
            placements: chunk.map((documentId) => ({
              documentId,
              folderId: 'f1',
              newFolderPath: null,
              reason: 'Passt.',
              confidence: 0.9,
            })),
            error: null,
            traceId: null,
          }
    )
    const slice = await runRootSortSlice(SESSION, PAYLOAD)
    // Still judging: nothing to tell anyone yet.
    expect(announceRootSortRun).not.toHaveBeenCalled()
    expect(planRootChunk).toHaveBeenCalledTimes(3)
    // The shelf's folders and conventions are read once for the slice, not once per chunk.
    expect(sortContextFor).toHaveBeenCalledTimes(1)
    expect(new Set(vi.mocked(planRootChunk).mock.calls.map((call) => call[3]))).toEqual(new Set([CONTEXT]))
    expect(slice.done).toBe(false)
    const [{ from, patch }] = written()
    expect(from).toEqual(['judging'])
    expect(patch.cursor).toBe(ROOT_SORT_CHUNK * 3)
    expect(patch.status).toBe('judging')
    expect(patch.placements).toHaveLength(ROOT_SORT_CHUNK * 2)
    expect(patch.failedDocumentIds).toHaveLength(ROOT_SORT_CHUNK)
  })

  it('moves on to grouping after the last chunk', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ documentIds: ids(10) }))
    vi.mocked(planRootChunk).mockResolvedValue({ placements: [], error: null, traceId: null })
    await runRootSortSlice(SESSION, PAYLOAD)
    expect(written()[0].patch.status).toBe('grouping')
  })

  it('groups only what nothing placed, and is ready even when the grouping failed', async () => {
    const placement = { documentId: 'd0', folderId: 'f1', newFolderPath: null, reason: 'Passt.', confidence: 0.9 }
    vi.mocked(findRootSortRun).mockResolvedValue(
      run({ status: 'grouping', documentIds: ids(4), placements: [placement], failedDocumentIds: ['d1'] })
    )
    vi.mocked(proposeRootFolders).mockResolvedValue({ proposals: [], error: 'backend_unreachable', traceId: null })
    const slice = await runRootSortSlice(SESSION, PAYLOAD)
    expect(vi.mocked(proposeRootFolders).mock.calls[0][2]).toEqual(['d2', 'd3'])
    expect(written()[0].patch).toEqual({ newFolders: [], groupingError: 'backend_unreachable', status: 'ready' })
    expect(slice.done).toBe(true)
    // Ready waits on the person: they are told, whether or not the dialog is open.
    expect(announceRootSortRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }))
  })

  it('creates the kept new folders once, before the first move, and applies through moveDocumentToFolder', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(
      run({
        status: 'applying',
        documentIds: ['d0', 'd1', 'd2'],
        keptMoves: [
          { documentId: 'd0', folderId: 'f1', newFolderPath: null },
          { documentId: 'd1', folderId: null, newFolderPath: '05 Fotos' },
          { documentId: 'd2', folderId: null, newFolderPath: '06 Nicht angelegt' },
        ],
      })
    )
    vi.mocked(ensureProjectFolderPaths).mockResolvedValue({ ok: true, folders: [], folderIdByPath: { '05 fotos': 'f-new' } })
    vi.mocked(moveDocumentsToFolders).mockImplementation(async (moves) =>
      moves.map((move) => ({ documentId: move.documentId, ok: true, error: null }))
    )
    const slice = await runRootSortSlice(SESSION, PAYLOAD)
    expect(ensureProjectFolderPaths).toHaveBeenCalledWith(
      { projectId: 'p1', parentId: null, paths: ['05 Fotos', '06 Nicht angelegt'] },
      SESSION
    )
    expect(moveDocumentsToFolders).toHaveBeenCalledWith(
      [
        { documentId: 'd0', folderId: 'f1' },
        { documentId: 'd1', folderId: 'f-new' },
      ],
      SESSION
    )
    const { patch } = written()[0]
    expect(patch.status).toBe('applied')
    expect(patch.movedDocumentIds).toEqual(['d0', 'd1'])
    expect(patch.moveFailures).toEqual([{ documentId: 'd2', error: 'The new folder could not be created.' }])
    expect(slice.done).toBe(true)
  })

  it('undoes exactly what the run moved, back to the root, and keeps its failures apart', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(
      run({ status: 'undoing', movedDocumentIds: ['d0', 'd1'], moveFailures: [{ documentId: 'd9', error: 'x' }] })
    )
    vi.mocked(moveDocumentsToFolders).mockImplementation(async (moves) =>
      moves.map((move) => ({ documentId: move.documentId, ok: move.documentId !== 'd1', error: move.documentId === 'd1' ? 'Folder is read-only.' : null }))
    )
    await runRootSortSlice(SESSION, PAYLOAD)
    expect(moveDocumentsToFolders).toHaveBeenCalledWith(
      [
        { documentId: 'd0', folderId: null },
        { documentId: 'd1', folderId: null },
      ],
      SESSION
    )
    const { patch } = written()[0]
    expect(patch.status).toBe('undone')
    expect(patch.undoFailures).toEqual([{ documentId: 'd1', error: 'Folder is read-only.' }])
    expect(patch.moveFailures).toBeUndefined()
  })

  it('ends without work for a run that is not working, or is not this person’s', async () => {
    vi.mocked(findRootSortRun).mockResolvedValueOnce(run({ status: 'cancelled' }))
    expect(await runRootSortSlice(SESSION, PAYLOAD)).toEqual({ done: true, payload: PAYLOAD })
    vi.mocked(findRootSortRun).mockResolvedValueOnce(run({ requestedBy: 'someone-else' }))
    expect(await runRootSortSlice(SESSION, PAYLOAD)).toEqual({ done: true, payload: PAYLOAD })
    expect(planRootChunk).not.toHaveBeenCalled()
    expect(updateRootSortRun).not.toHaveBeenCalled()
  })

  it('fails the run with its reason when the person lost the shelf', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ documentIds: ids(3) }))
    vi.mocked(requireSortable).mockRejectedValue(new ForbiddenError())
    const slice = await runRootSortSlice(SESSION, PAYLOAD)
    expect(slice.done).toBe(true)
    expect(written()[0].patch.status).toBe('failed')
    expect(announceRootSortRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })

  it('stops when the person cancelled while the slice ran', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ documentIds: ids(ROOT_SORT_CHUNK * 4) }))
    vi.mocked(planRootChunk).mockResolvedValue({ placements: [], error: null, traceId: null })
    vi.mocked(updateRootSortRun).mockResolvedValue(null)
    expect((await runRootSortSlice(SESSION, PAYLOAD)).done).toBe(true)
  })
})

describe('keptMovesOf', () => {
  const RUN = run({
    documentIds: ['d0', 'd1', 'd2', 'd3'],
    newFolders: [{ path: '05 Fotos', description: null, documentIds: ['d1'], confidences: {} }],
  })

  it('keeps a document of the run into a folder or a new folder the run proposed', () => {
    expect(
      keptMovesOf(RUN, [
        { documentId: 'd0', folderId: '00000000-0000-4000-8000-000000000001', newFolderPath: null },
        { documentId: 'd1', folderId: null, newFolderPath: '05 fotos' },
      ])
    ).toHaveLength(2)
  })

  it('drops a document the run never read, a second move of one, a stay, and a folder nobody proposed', () => {
    expect(
      keptMovesOf(RUN, [
        { documentId: 'elsewhere', folderId: '00000000-0000-4000-8000-000000000001', newFolderPath: null },
        { documentId: 'd0', folderId: '00000000-0000-4000-8000-000000000001', newFolderPath: null },
        { documentId: 'd0', folderId: '00000000-0000-4000-8000-000000000002', newFolderPath: null },
        { documentId: 'd2', folderId: null, newFolderPath: null },
        { documentId: 'd3', folderId: null, newFolderPath: 'Erfunden' },
      ]).map((move) => move.documentId)
    ).toEqual(['d0'])
  })
})

describe('startRootSort', () => {
  it('refuses a second run in work on the shelf', async () => {
    vi.mocked(scanRoot).mockResolvedValue({
      folders: [{ id: 'f1', parentId: null, name: 'A', path: 'A' }],
      documents: [{ id: 'd0', name: 'x.pdf' }],
      unreadable: 0,
      truncated: false,
    })
    vi.mocked(insertRootSortRun).mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'root_sort_runs_one_in_work_per_shelf' })
    )
    await expect(startRootSort(SESSION, { kind: 'project', projectId: 'p1' })).rejects.toBeInstanceOf(ConflictError)
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})
