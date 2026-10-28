/**
 * @vitest-environment node
 *
 * The request the projects client puts on the wire, the list it answers, and
 * the status it surfaces when the read fails. A caller that abandons the read
 * passes a signal, which must reach the fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { getProjectCollection, listProjects } from './projects-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listProjects', () => {
  it('reads the projects the caller can see', async () => {
    const projects = [{ id: 'p-1', name: 'Wohnhaus' }]
    fetchMock.mockResolvedValueOnce(Response.json(projects))

    await expect(listProjects()).resolves.toEqual(projects)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', { signal: undefined })
  })

  it('passes the signal so the caller can abandon the read', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([]))
    const controller = new AbortController()

    await listProjects({ signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects', { signal: controller.signal })
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }))

    const failure = await listProjects().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 403 })
  })
})

describe('getProjectCollection', () => {
  it('reads one project by its encoded id and answers its collection', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: 'p/1', collectionName: 'proj_1' }))

    await expect(getProjectCollection('p/1')).resolves.toEqual({ id: 'p/1', collectionName: 'proj_1' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p%2F1')
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))

    const failure = await getProjectCollection('p-1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 404 })
  })
})
