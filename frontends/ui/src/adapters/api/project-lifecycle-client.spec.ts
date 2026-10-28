/**
 * @vitest-environment node
 *
 * The URLs, methods and bodies the project lifecycle client puts on the wire,
 * and the refusal it carries back. The callers branch on the status (a 409 is
 * "someone moved it first", a 403 on the deletions list is "nothing to show")
 * and show the server's own sentence when the envelope has one, so both must
 * arrive intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import {
  deleteProject,
  getProjectRecord,
  listDeletions,
  ProjectRequestError,
  reindexProject,
  renameProject,
  restoreProject,
  setProjectStatus,
} from './project-lifecycle-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('project changes', () => {
  it('renames the project with a PATCH of the name', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await renameProject('p-1', 'Neu')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Neu' }),
    })
  })

  it('deletes with a DELETE that names the project again, and answers the grace deadline', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ purgeAfter: '2026-12-01T00:00:00Z' }))

    await expect(deleteProject('p-1', 'Wohnhaus')).resolves.toEqual({ purgeAfter: '2026-12-01T00:00:00Z' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1', {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ confirmName: 'Wohnhaus' }),
    })
  })

  it('answers an empty deletion when the success body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }))

    await expect(deleteProject('p-1', 'Wohnhaus')).resolves.toEqual({})
  })

  it('restores with a POST to the restore route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await restoreProject('p-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/restore', { method: 'POST' })
  })

  it('queues a reindex with a POST to the reindex route', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }))

    await reindexProject('p-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/reindex', { method: 'POST' })
  })

  it('moves the status with a PUT of the change', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await setProjectStatus('p-1', { status: 'paused' })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/status', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'paused' }),
    })
  })
})

describe('refusals', () => {
  it('carries the status and the server sentence, so a 409 can be told apart', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Schon geändert' }, { status: 409 }))

    const failure = await setProjectStatus('p-1', { status: 'active' }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ProjectRequestError)
    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 409, serverMessage: 'Schon geändert' })
  })

  it('carries no server sentence when the refusal body is not an envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 500 }))

    const failure = await restoreProject('p-1').catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 500, serverMessage: null })
  })
})

describe('reads', () => {
  it('reads the closing record of the project', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ people: [] }))

    await expect(getProjectRecord('p-1')).resolves.toEqual({ people: [] })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/project-record')
  })

  it('reads the recently-deleted list, and a refusal keeps its status for the caller', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }))

    const failure = await listDeletions().catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 403 })
  })

  it('answers the deletion entries as the server sent them', async () => {
    const rows = [{ id: 'd-1', entityType: 'project', entityId: 'p-1', displayName: 'Wohnhaus' }]
    fetchMock.mockResolvedValueOnce(Response.json(rows))

    await expect(listDeletions()).resolves.toEqual(rows)
    expect(fetchMock).toHaveBeenCalledWith('/api/deletions')
  })
})
