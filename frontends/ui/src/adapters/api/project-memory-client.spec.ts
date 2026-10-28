/**
 * @vitest-environment node
 *
 * The requests the closing debrief makes on a project's memory and experience,
 * and the status each failure carries. The debrief reports every failure of
 * these calls as one failed state, so the status must be what the caller gets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import {
  addProjectMemoryItem,
  extractProjectExperience,
  listProjectMemory,
  updateProjectMemoryItem,
} from './project-memory-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('listProjectMemory', () => {
  it('reads one page with its limit', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }))

    await listProjectMemory('p-1', { limit: 200 })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/memory?limit=200')
  })

  it('carries the cursor of the next page when there is one', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }))

    await listProjectMemory('p-1', { limit: 200, cursor: 'c 2' })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/memory?limit=200&cursor=c+2')
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    const failure = await listProjectMemory('p-1', { limit: 200 }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 500 })
  })
})

describe('updateProjectMemoryItem', () => {
  it('PATCHes the confirmation to the item', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ item: { id: 'm-1' } }))

    await updateProjectMemoryItem('p-1', 'm-1', { verification: 'user_confirmed' })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/memory/m-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ verification: 'user_confirmed' }),
    })
  })

  it('PATCHes the dismissal to the item', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ item: { id: 'm-1' } }))

    await updateProjectMemoryItem('p-1', 'm-1', { status: 'dismissed' })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/memory/m-1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'dismissed' }),
    })
  })
})

describe('addProjectMemoryItem', () => {
  it('POSTs the lesson as a decision', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ item: { id: 'm-2' } }))

    await addProjectMemoryItem('p-1', { kind: 'decision', content: 'Nachtrag' })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/memory', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'decision', content: 'Nachtrag' }),
    })
  })
})

describe('extractProjectExperience', () => {
  it('POSTs the extraction and answers its result, an error reason included', async () => {
    const result = { error: 'no_documents' }
    fetchMock.mockResolvedValueOnce(Response.json(result))

    await expect(extractProjectExperience('p-1')).resolves.toEqual(result)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/experience', { method: 'POST' })
  })

  it('throws the typed error with the status when the request is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }))

    const failure = await extractProjectExperience('p-1').catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 403 })
  })
})
