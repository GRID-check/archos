/**
 * @vitest-environment node
 *
 * The requests the project record editor puts on the wire. Each save is one
 * route and one method; a refused save must surface its status so the editor
 * can say it did not go through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import {
  addProjectPerson,
  removeProjectPerson,
  saveProjectStartMonth,
  updateProjectPerson,
  type ProjectPersonInput,
} from './project-record-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const person: ProjectPersonInput = {
  name: 'Ada Lovelace',
  function: 'Planerin',
  company: 'Büro Nord',
  startedOn: '2025-03',
  endedOn: null,
  userId: null,
}

describe('saveProjectStartMonth', () => {
  it('PUTs the month to the project record', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))

    await saveProjectStartMonth('p-1', '2025-03')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/project-record', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ startedOn: '2025-03' }),
    })
  })

  it('sends null to clear the start month', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))

    await saveProjectStartMonth('p-1', null)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p-1/project-record',
      expect.objectContaining({ body: JSON.stringify({ startedOn: null }) }),
    )
  })

  it('throws the typed error with the status when the save is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 422 }))

    const failure = await saveProjectStartMonth('p-1', '2025-03').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 422 })
  })
})

describe('addProjectPerson', () => {
  it('POSTs the person to the project people route', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }))

    await addProjectPerson('p-1', person)

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/people', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(person),
    })
  })

  it('throws the typed error with the status when the add is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }))

    await expect(addProjectPerson('p-1', person)).rejects.toMatchObject({ status: 403 })
  })
})

describe('updateProjectPerson', () => {
  it('PATCHes the person under its id', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))

    await updateProjectPerson('p-1', 'per-9', person)

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/people/per-9', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(person),
    })
  })

  it('throws the typed error with the status when the update is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))

    await expect(updateProjectPerson('p-1', 'per-9', person)).rejects.toMatchObject({ status: 404 })
  })
})

describe('removeProjectPerson', () => {
  it('DELETEs the person under its id', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await removeProjectPerson('p-1', 'per-9')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/people/per-9', { method: 'DELETE' })
  })

  it('throws the typed error with the status when the removal is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    await expect(removeProjectPerson('p-1', 'per-9')).rejects.toMatchObject({ status: 500 })
  })
})
