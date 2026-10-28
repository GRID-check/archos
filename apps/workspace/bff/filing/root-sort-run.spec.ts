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
  cancelReadyRootSortRuns: vi.fn(),
  failStalledRootSortRuns: vi.fn(),
  findLatestRootSortRun: vi.fn(),
  findRootSortRun: vi.fn(),
  insertRootSortRun: vi.fn(),
  isRootSortJobWaiting: vi.fn(),
  recordRootSortProgress: vi.fn(),
  updateRootSortRun: vi.fn(),
}))
vi.mock('./repository', () => ({ findRootDocuments: vi.fn(), findShelfFolderPaths: vi.fn() }))
vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentsToFolders: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('./root-sort-announce', () => ({ announceRootSortRun: vi.fn(), settleRootSortNotices: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({ ensureProjectFolderPaths: vi.fn() }))
vi.mock('@/lib/office-shelf/folder-service', () => ({ ensureOfficeShelfFolderPaths: vi.fn() }))

import { ConflictError, ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { RootSortRun } from '@/lib/db/schema/root-sort-runs'
import { moveDocumentsToFolders } from '@/lib/documents/move-to-folder'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import type { RootSortPayload } from '@/lib/jobs-queue/types'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { planRootChunk, proposeRootFolders, requireSortable, scanRoot, sortContextFor, type SortContext } from './root-sort'
import { applyRootSort, cancelRootSort, keptMovesOf, runRootSortSlice, startRootSort, undoRootSort, viewOf } from './root-sort-run'
import {
  cancelReadyRootSortRuns,
  isRootSortJobWaiting,
  recordRootSortProgress,
  failStalledRootSortRuns,
  findRootSortRun,
  insertRootSortRun,
  updateRootSortRun,
} from './root-sort-run-repository'
import { findRootDocuments, findShelfFolderPaths } from './repository'
import { announceRootSortRun, settleRootSortNotices } from './root-sort-announce'
import { CHUNKS_PER_SLICE, ROOT_SORT_CHUNK } from './root-sort-types'

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
    progressDone: 0,
    unreadable: 0,
    truncated: false,
    placements: [],
    failedDocumentIds: [],
    newFolders: [],
    keptMoves: [],
    movedDocuments: [],
    jobId: null,
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
  vi.mocked(failStalledRootSortRuns).mockResolvedValue([])
  vi.mocked(cancelReadyRootSortRuns).mockResolvedValue([])
  vi.mocked(isRootSortJobWaiting).mockResolvedValue(false)
  vi.mocked(requireSortable).mockResolvedValue()
  vi.mocked(updateRootSortRun).mockImplementation(async (_org, _id, _from, patch) => run(patch))
})

describe('runRootSortSlice', () => {
  it('judges a slice of chunks side by side, records a failed chunk, and keeps going', async () => {
    const documentIds = ids(ROOT_SORT_CHUNK * (CHUNKS_PER_SLICE + 1))
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
    expect(planRootChunk).toHaveBeenCalledTimes(CHUNKS_PER_SLICE)
    // The shelf's folders and conventions are read once for the slice, not once per chunk.
    expect(sortContextFor).toHaveBeenCalledTimes(1)
    expect(new Set(vi.mocked(planRootChunk).mock.calls.map((call) => call[3]))).toEqual(new Set([CONTEXT]))
    expect(slice.done).toBe(false)
    const [{ from, patch }] = written()
    expect(from).toEqual(['judging'])
    expect(patch.cursor).toBe(ROOT_SORT_CHUNK * CHUNKS_PER_SLICE)
    expect(patch.status).toBe('judging')
    expect(patch.placements).toHaveLength(ROOT_SORT_CHUNK * (CHUNKS_PER_SLICE - 1))
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
      moves.map((move) => ({ documentId: move.documentId, ok: true, error: null, changed: true }))
    )
    const slice = await runRootSortSlice(SESSION, PAYLOAD)
    expect(ensureProjectFolderPaths).toHaveBeenCalledWith(
      { projectId: 'p1', parentId: null, paths: ['05 Fotos', '06 Nicht angelegt'] },
      SESSION
    )
    // Each move only from the root, where the run found the document.
    expect(moveDocumentsToFolders).toHaveBeenCalledWith(
      [
        { documentId: 'd0', folderId: 'f1', expectedFolderId: null },
        { documentId: 'd1', folderId: 'f-new', expectedFolderId: null },
      ],
      SESSION,
      { deadline: expect.any(Number), onProgress: expect.any(Function), concurrency: 4 }
    )
    const { patch } = written()[0]
    expect(patch.status).toBe('applied')
    expect(patch.movedDocuments).toEqual([
      { documentId: 'd0', folderId: 'f1' },
      { documentId: 'd1', folderId: 'f-new' },
    ])
    expect(patch.moveFailures).toEqual([{ documentId: 'd2', error: 'The new folder could not be created.' }])
    expect(slice.done).toBe(true)
  })

  it('undoes exactly what the run moved, back to the root, and keeps its failures apart', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(
      run({
        status: 'undoing',
        movedDocuments: [
          { documentId: 'd0', folderId: 'f1' },
          { documentId: 'd1', folderId: 'f2' },
        ],
        moveFailures: [{ documentId: 'd9', error: 'x' }],
      })
    )
    vi.mocked(moveDocumentsToFolders).mockImplementation(async (moves) =>
      moves.map((move) => ({ documentId: move.documentId, ok: move.documentId !== 'd1', error: move.documentId === 'd1' ? 'Folder is read-only.' : null }))
    )
    await runRootSortSlice(SESSION, PAYLOAD)
    // Only where the run put it: a document filed since stays where it is.
    expect(moveDocumentsToFolders).toHaveBeenCalledWith(
      [
        { documentId: 'd0', folderId: null, expectedFolderId: 'f1' },
        { documentId: 'd1', folderId: null, expectedFolderId: 'f2' },
      ],
      SESSION,
      { deadline: expect.any(Number), onProgress: expect.any(Function), concurrency: 4 }
    )
    const { patch } = written()[0]
    expect(patch.status).toBe('undone')
    expect(patch.undoFailures).toEqual([{ documentId: 'd1', error: 'Folder is read-only.' }])
    expect(patch.moveFailures).toBeUndefined()
  })

  it('stops starting moves at the slice budget and carries on from the first one not reached', async () => {
    const keptMoves = ['d0', 'd1', 'd2'].map((documentId) => ({ documentId, folderId: 'f1', newFolderPath: null }))
    vi.mocked(findRootSortRun).mockResolvedValue(run({ status: 'applying', cursor: 1, keptMoves }))
    // The deadline let one of the two remaining moves start.
    vi.mocked(moveDocumentsToFolders).mockResolvedValue([{ documentId: 'd1', ok: true, error: null, changed: true }])
    const slice = await runRootSortSlice(SESSION, PAYLOAD)
    const [{ patch }] = written()
    expect(patch.cursor).toBe(2)
    expect(patch.status).toBe('applying')
    expect(slice.done).toBe(false)
  })

  it('records only moves that changed something, so an undo never moves what the run did not', async () => {
    const keptMoves = ['d0', 'd1'].map((documentId) => ({ documentId, folderId: 'f1', newFolderPath: null }))
    vi.mocked(findRootSortRun).mockResolvedValue(run({ status: 'applying', cursor: 1, keptMoves }))
    vi.mocked(moveDocumentsToFolders).mockResolvedValue([{ documentId: 'd1', ok: true, error: null, changed: false }])
    await runRootSortSlice(SESSION, PAYLOAD)
    expect(written()[0].patch.movedDocuments).toEqual([])
  })

  it('writes a slice only over the cursor it started from', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ documentIds: ids(10), cursor: 0 }))
    vi.mocked(planRootChunk).mockResolvedValue({ placements: [], error: null, traceId: null })
    await runRootSortSlice(SESSION, PAYLOAD)
    expect(vi.mocked(updateRootSortRun).mock.calls[0][4]).toEqual({ cursor: 0 })
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
  const OPEN = new Set(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'])
  const RUN = run({
    documentIds: ['d0', 'd1', 'd2', 'd3'],
    newFolders: [{ path: '05 Fotos', description: null, documentIds: ['d1'], confidences: {} }],
  })

  it('keeps a document of the run into a folder or a new folder the run proposed', () => {
    expect(
      keptMovesOf(RUN, [
        { documentId: 'd0', folderId: '00000000-0000-4000-8000-000000000001', newFolderPath: null },
        { documentId: 'd1', folderId: null, newFolderPath: '05 fotos' },
      ], OPEN)
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
      ], OPEN).map((move) => move.documentId)
    ).toEqual(['d0'])
  })

  it('drops a folder the review did not offer, and a move naming both a folder and a new folder', () => {
    expect(
      keptMovesOf(RUN, [
        { documentId: 'd0', folderId: '00000000-0000-4000-8000-00000000dead', newFolderPath: null },
        { documentId: 'd1', folderId: '00000000-0000-4000-8000-000000000001', newFolderPath: '05 Fotos' },
      ], OPEN)
    ).toEqual([])
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

const SCAN = {
  folders: [{ id: 'f1', parentId: null, name: 'A', path: 'A' }],
  documents: [{ id: 'd0', name: 'x.pdf' }],
  unreadable: 0,
  truncated: false,
}

describe('a run is never left working with nothing working on it', () => {
  it('ends a new run whose job could not be queued, and says so', async () => {
    vi.mocked(scanRoot).mockResolvedValue(SCAN)
    vi.mocked(insertRootSortRun).mockResolvedValue(run({ documentIds: ['d0'] }))
    vi.mocked(enqueueJob).mockRejectedValue(new Error('queue down'))
    await expect(startRootSort(SESSION, { kind: 'project', projectId: 'p1' })).rejects.toThrow('queue down')
    // The run names its job first, so a missing job is told from a waiting one; the failed queueing ends it.
    expect(written()).toEqual([
      { from: ['judging'], patch: { jobId: expect.any(String) } },
      { from: ['judging'], patch: expect.objectContaining({ status: 'failed', error: 'not_queued', jobId: null }) },
    ])
    expect(vi.mocked(enqueueJob).mock.calls[0][0].jobId).toBe(written()[0].patch.jobId)
  })

  it('takes an apply back to ready when its job could not be queued', async () => {
    const ready = run({
      status: 'ready',
      documentIds: ['d0'],
      placements: [{ documentId: 'd0', folderId: 'f1', newFolderPath: null, reason: 'Passt.', confidence: 0.9 }],
    })
    vi.mocked(findRootSortRun).mockResolvedValue(ready)
    vi.mocked(scanRoot).mockResolvedValue({ ...SCAN, folders: [{ id: '00000000-0000-4000-8000-000000000001', parentId: null, name: 'A', path: 'A' }] })
    vi.mocked(enqueueJob).mockRejectedValue(new Error('queue down'))
    const keep = [{ documentId: 'd0', folderId: '00000000-0000-4000-8000-000000000001', newFolderPath: null }]
    await expect(applyRootSort(SESSION, ready.id, keep)).rejects.toThrow('queue down')
    expect(written().at(-1)).toEqual({
      from: ['applying'],
      patch: { status: 'ready', keptMoves: [], cursor: 0, jobId: null },
    })
  })

  it('ends the shelf’s stalled runs and replaces this person’s waiting reviews before a new one starts', async () => {
    const stalled = run({ status: 'failed', error: 'stalled' })
    vi.mocked(failStalledRootSortRuns).mockResolvedValue([stalled])
    vi.mocked(scanRoot).mockResolvedValue(SCAN)
    vi.mocked(insertRootSortRun).mockResolvedValue(run({ documentIds: ['d0'] }))
    await startRootSort(SESSION, { kind: 'project', projectId: 'p1' })
    expect(failStalledRootSortRuns).toHaveBeenCalledWith('org-1', { kind: 'project', projectId: 'p1' })
    expect(cancelReadyRootSortRuns).toHaveBeenCalledWith('org-1', { kind: 'project', projectId: 'p1' }, 'user-1')
    expect(announceRootSortRun).toHaveBeenCalledWith(stalled)
    expect(vi.mocked(failStalledRootSortRuns).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(insertRootSortRun).mock.invocationCallOrder[0]
    )
  })

  it('undoes what a run moved before it failed part of the way through applying', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(
      run({ status: 'failed', error: 'stalled', movedDocuments: [{ documentId: 'd0', folderId: 'f1' }] })
    )
    await undoRootSort(SESSION, PAYLOAD.runId)
    expect(written()[0]).toEqual({ from: ['applied', 'failed'], patch: { status: 'undoing', cursor: 0, progressDone: 0 } })
    expect(written()[1]).toEqual({ from: ['undoing'], patch: { jobId: expect.any(String) } })
    expect(enqueueJob).toHaveBeenCalled()
  })

  it('refuses to undo a run that moved nothing', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ status: 'failed' }))
    await expect(undoRootSort(SESSION, PAYLOAD.runId)).rejects.toThrow('moved nothing')
  })
})

describe('a run shows its progress as it happens', () => {
  const placed = (chunk: readonly string[]) => ({
    placements: chunk.map((documentId) => ({ documentId, folderId: 'f1', newFolderPath: null, reason: 'Passt.', confidence: 0.9 })),
    error: null,
    traceId: null,
  })

  it('counts each judged chunk past the cursor while the slice runs, written only over the step it read', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ documentIds: ids(ROOT_SORT_CHUNK * CHUNKS_PER_SLICE), cursor: 0 }))
    vi.mocked(planRootChunk).mockImplementation(async (_session, _shelf, chunk) => placed(chunk))
    await runRootSortSlice(SESSION, PAYLOAD)
    // The first chunk to finish is written at once; the rest wait out the write interval.
    expect(recordRootSortProgress).toHaveBeenCalledWith('org-1', PAYLOAD.runId, { status: 'judging', cursor: 0 }, ROOT_SORT_CHUNK)
    // The slice's commit brings the live count up to the cursor it commits.
    const { patch } = written()[0]
    expect(patch.progressDone).toBe(patch.cursor)
  })

  it('never fails a slice because its progress could not be written', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ documentIds: ids(2) }))
    vi.mocked(planRootChunk).mockImplementation(async (_session, _shelf, chunk) => placed(chunk))
    vi.mocked(recordRootSortProgress).mockRejectedValue(new Error('db busy'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slice = await runRootSortSlice(SESSION, PAYLOAD)
    expect(written()[0].patch.cursor).toBe(2)
    expect(slice.done).toBe(false)
    warn.mockRestore()
  })

  it('reads the live count ahead of the cursor, and what grouping is working on', async () => {
    const judging = await viewOf(SESSION, run({ documentIds: ids(100), cursor: 40, progressDone: 55 }))
    expect(judging.progress).toEqual({ done: 55, total: 100 })
    const grouping = await viewOf(
      SESSION,
      run({
        status: 'grouping',
        documentIds: ids(5),
        cursor: 5,
        placements: [{ documentId: 'd0', folderId: 'f1', newFolderPath: null, reason: '', confidence: null }],
        failedDocumentIds: ['d1'],
      })
    )
    expect(grouping.progress).toEqual({ done: 0, total: 3 })
  })

  it('says when the run waits for a free slot in the job pool, and only while it is working', async () => {
    vi.mocked(isRootSortJobWaiting).mockResolvedValue(true)
    expect((await viewOf(SESSION, run({ jobId: 'j1' }))).waiting).toBe(true)
    expect((await viewOf(SESSION, run({ status: 'cancelled', jobId: 'j1' }))).waiting).toBe(false)
  })

  it('names the latest placements while judging, newest first, with the folder each went to', async () => {
    vi.mocked(findRootDocuments).mockResolvedValue([
      { id: 'd1', filename: 'b.pdf', displayName: 'Bescheid' },
      { id: 'd2', filename: 'c.pdf', displayName: null },
    ] as never)
    vi.mocked(findShelfFolderPaths).mockResolvedValue(new Map([['f1', '03 Behörde']]))
    const view = await viewOf(
      SESSION,
      run({
        placements: [
          { documentId: 'd1', folderId: 'f1', newFolderPath: null, reason: '', confidence: 0.9 },
          { documentId: 'd2', folderId: 'f1', newFolderPath: null, reason: '', confidence: 0.9 },
        ],
      })
    )
    expect(view.recent).toEqual([
      { name: 'c.pdf', folderPath: '03 Behörde' },
      { name: 'Bescheid', folderPath: '03 Behörde' },
    ])
  })
})

describe('a notice never outlives what it announced', () => {
  it('settles the run’s notices when the person applies or cancels it', async () => {
    vi.mocked(findRootSortRun).mockResolvedValue(run({ status: 'ready' }))
    await cancelRootSort(SESSION, PAYLOAD.runId)
    expect(settleRootSortNotices).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })

  it('settles the notices of the waiting reviews a new run replaces', async () => {
    const replaced = run({ id: 'old', status: 'cancelled' })
    vi.mocked(cancelReadyRootSortRuns).mockResolvedValue([replaced])
    vi.mocked(scanRoot).mockResolvedValue(SCAN)
    vi.mocked(insertRootSortRun).mockResolvedValue(run())
    await startRootSort(SESSION, { kind: 'project', projectId: 'p1' })
    expect(settleRootSortNotices).toHaveBeenCalledWith(replaced)
  })
})
