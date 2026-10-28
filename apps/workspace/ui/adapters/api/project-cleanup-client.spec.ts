/**
 * @vitest-environment node
 *
 * The requests the clean-out client puts on the wire, and the refusal envelope
 * it keeps. A clean-out that could not be fully undone says which folders it
 * may have left files in; the close dialog shows them, so the body must reach it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { CleanupRequestError, requestCleanupProposal, runCleanup } from './project-cleanup-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('requestCleanupProposal', () => {
  it('POSTs the locale and answers the proposal', async () => {
    const proposal = { aiUsed: true, items: [] }
    fetchMock.mockResolvedValueOnce(Response.json(proposal))

    await expect(requestCleanupProposal('p-1', 'en')).resolves.toEqual(proposal)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/cleanup/proposal', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ locale: 'en' }),
    })
  })

  it('throws the typed error with the status when the proposal fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 502 }))

    const failure = await requestCleanupProposal('p-1', 'de').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 502 })
  })
})

describe('runCleanup', () => {
  it('POSTs the chosen documents with the proposal they came from', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}))

    await runCleanup('p-1', { documentIds: ['d-1'], proposedIds: ['d-1', 'd-2'], aiUsed: false })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p-1/cleanup', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentIds: ['d-1'], proposedIds: ['d-1', 'd-2'], aiUsed: false }),
    })
  })

  it('keeps the refusal envelope, so the folders it names can be shown', async () => {
    const envelope = { error: 'teilweise', details: { reason: 'cleanup-partially-undone', folders: ['Akten'] } }
    fetchMock.mockResolvedValueOnce(Response.json(envelope, { status: 409 }))

    const failure = await runCleanup('p-1', { documentIds: [], proposedIds: [], aiUsed: true }).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(CleanupRequestError)
    expect(failure).toMatchObject({ status: 409, body: envelope })
  })

  it('keeps no body when the refusal is not an envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 500 }))

    const failure = await runCleanup('p-1', { documentIds: [], proposedIds: [], aiUsed: false }).catch(
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({ status: 500, body: null })
  })
})
