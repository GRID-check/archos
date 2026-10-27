/**
 * @vitest-environment node
 *
 * The URLs and the error mapping of the tasks client's run list. The Tasks
 * timeline reads the project's run feed through `listProjectRuns`; its caller
 * catches every failure, so what is pinned here is the one thing no other layer
 * looks at: the path, the page size, and that a failed read throws the typed
 * error with the status attached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JobApiError, listProjectRuns } from './jobs-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listProjectRuns', () => {
  it('reads the project run feed at the requested page size', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ runs: [], nextCursor: null }))

    await listProjectRuns('proj/1', { limit: 200 })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj%2F1/runs?limit=200')
  })

  it('returns the runs of the page', async () => {
    const runs = [{ id: 'run-1' }, { id: 'run-2' }]
    fetchMock.mockResolvedValueOnce(Response.json({ runs, nextCursor: null }))

    await expect(listProjectRuns('p', { limit: 200 })).resolves.toEqual(runs)
  })

  it('answers an empty list when the page carries no runs', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await expect(listProjectRuns('p', { limit: 200 })).resolves.toEqual([])
  })

  it('throws the typed error with the status and the server message', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'boom', code: 'INTERNAL' }, { status: 500 }))

    const failure = await listProjectRuns('p', { limit: 200 }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(JobApiError)
    expect(failure).toMatchObject({ status: 500, code: 'INTERNAL', serverMessage: 'boom' })
  })
})
