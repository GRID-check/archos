/**
 * @vitest-environment node
 *
 * The JSON-patch request that accepts a suggested fact, and the status a refused
 * patch carries back to the debrief.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { applyProjectProfileFact } from './project-profile-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('applyProjectProfileFact', () => {
  it('POSTs one add operation at the fact path', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await applyProjectProfileFact('p-1', 'oib_edition', 'OIB 2019')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/profile/patches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: [{ op: 'add', path: '/facts/oib_edition', value: 'OIB 2019' }] }),
    })
  })

  it('throws the typed error with the status when the patch is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 422 }))

    const failure = await applyProjectProfileFact('p-1', 'k', 1).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 422 })
  })
})
