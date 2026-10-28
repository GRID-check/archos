/**
 * @vitest-environment node
 *
 * The URL and the signal the quality scope client puts on the wire, and the
 * status a failed read surfaces. The scope bar shows a failure as a failed
 * picker, so the status must reach the caller intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { getQualityScopeOptions } from './quality-scope-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getQualityScopeOptions', () => {
  it('reads the scope options for the query, with the signal', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ organizations: [], projects: [] }))
    const controller = new AbortController()

    await getQualityScopeOptions('from=2026-01-01', { signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledWith('/api/platform/quality/scope-options?from=2026-01-01', {
      signal: controller.signal,
    })
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    const failure = await getQualityScopeOptions('from=2026-01-01').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 500 })
  })
})
