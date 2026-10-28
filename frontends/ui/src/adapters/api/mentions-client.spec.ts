/**
 * @vitest-environment node
 *
 * The URLs and the method the mentions client puts on the wire, and the status
 * it surfaces. A failed poll keeps the thread's last known hand-off state, and
 * that decision is the caller's, so the status must reach it intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { getAwaitingState, getMentionCandidates, releaseMention } from './mentions-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAwaitingState', () => {
  it('reads the hand-off state of the thread', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ requests: [] }))

    await getAwaitingState('conv-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/conversations/conv-1/awaiting')
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }))

    const failure = await getAwaitingState('conv-1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 503 })
  })
})

describe('releaseMention', () => {
  it('POSTs the release of one request and answers the thread state', async () => {
    const state = { requests: [] }
    fetchMock.mockResolvedValueOnce(Response.json(state))

    await expect(releaseMention('req-1')).resolves.toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/mentions/req-1/release', { method: 'POST' })
  })

  it('surfaces a refused release with its status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 409 }))

    const failure = await releaseMention('req-1').catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 409 })
  })
})

describe('getMentionCandidates', () => {
  it('reads who the thread can name', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ candidates: [] }))

    await getMentionCandidates('conv 1')

    expect(fetchMock).toHaveBeenCalledWith('/api/conversations/conv%201/mention-candidates')
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))

    const failure = await getMentionCandidates('conv-1').catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 404 })
  })
})
