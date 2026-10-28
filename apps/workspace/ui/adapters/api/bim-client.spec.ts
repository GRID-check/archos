/**
 * @vitest-environment node
 *
 * The request the revision comparison puts on the wire: the method, the path,
 * the body the route parses, and what comes back. A comparison the server has
 * nothing to give is `null`, not a failure; anything else non-OK throws with
 * its status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { compareBimModel } from './bim-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('compareBimModel', () => {
  it('POSTs the compare op to the model query route', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ comparison: null }))

    await compareBimModel('model-1', { baseModelId: 'model-0', limit: 20_000 })

    expect(fetchMock).toHaveBeenCalledWith('/api/bim/models/model-1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'compare', baseModelId: 'model-0', limit: 20_000 }),
    })
  })

  it('answers the comparison the server computed', async () => {
    const comparison = { added: [], removed: [], changed: [] }
    fetchMock.mockResolvedValueOnce(Response.json({ comparison }))

    await expect(compareBimModel('model-1', { baseModelId: 'model-0', limit: 1 })).resolves.toEqual(comparison)
  })

  it('answers null when the server has no comparison to give', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await expect(compareBimModel('model-1', { baseModelId: 'model-0', limit: 1 })).resolves.toBeNull()
  })

  it('throws the typed error with the status when the query fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    const failure = await compareBimModel('model-1', { baseModelId: 'model-0', limit: 1 }).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 500 })
  })
})
