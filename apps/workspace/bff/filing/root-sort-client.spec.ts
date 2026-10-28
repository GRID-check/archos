/**
 * @vitest-environment node
 */
/**
 * The root sort's client: one short request per call, the paths written once,
 * and every answer parsed against the contract rather than cast.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyRootSortRun,
  fetchRootSortSummary,
  RootSortRequestError,
  rootSortPath,
  startRootSort,
  type RootSortFetch,
} from './root-sort-client'
import type { RootSortRunView } from './root-sort-types'

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const RUN: RootSortRunView = {
  id: 'run-1',
  status: 'judging',
  progress: { done: 0, total: 120 },
  waiting: false,
  recent: [],
  unreadable: 0,
  truncated: false,
  review: null,
  moved: 0,
  moveFailures: [],
  undoFailures: [],
  error: null,
  groupingError: null,
  createdAt: '2026-10-21T12:00:00.000Z',
  updatedAt: '2026-10-21T12:00:00.000Z',
}

describe('rootSortPath', () => {
  it('names the shelf', () => {
    expect(rootSortPath({ kind: 'project', projectId: 'p1' })).toBe('/api/projects/p1/root-sort')
    expect(rootSortPath({ kind: 'office_shelf' })).toBe('/api/office-shelf/root-sort')
  })
})

describe('the run', () => {
  it('starts with one request and reads the run back', async () => {
    const run = vi.fn<RootSortFetch>(async () => respond(200, RUN))
    expect(await startRootSort({ kind: 'project', projectId: 'p1' }, run)).toEqual(RUN)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('/api/projects/p1/root-sort', { method: 'POST' })
  })

  it('sends what the person kept in one request', async () => {
    const run = vi.fn<RootSortFetch>(async () => respond(200, { ...RUN, status: 'applying' }))
    const keep = [{ documentId: '00000000-0000-4000-8000-000000000001', folderId: null, newFolderPath: '05 Fotos' }]
    await applyRootSortRun('run-1', keep, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(run.mock.calls[0][1]?.body))).toEqual({ keep })
  })

  it('refuses an answer that is not the contract', async () => {
    const run: RootSortFetch = async () => respond(200, { files: 'many' })
    await expect(fetchRootSortSummary({ kind: 'office_shelf' }, run)).rejects.toThrow()
  })

  it('carries the server refusal', async () => {
    const run: RootSortFetch = async () => respond(409, { error: 'A sort of this shelf is already running.' })
    await expect(startRootSort({ kind: 'office_shelf' }, run)).rejects.toEqual(
      new RootSortRequestError(409, 'A sort of this shelf is already running.')
    )
  })
})
