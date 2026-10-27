/**
 * @vitest-environment node
 *
 * The URLs the answer-feedback client puts on the wire, the abort signal that
 * lets a superseded read stop, and the status a failed read surfaces. The
 * digest view shows a failure as "unavailable" and the filter views as a failed
 * count, so the status must reach the caller intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { getAnswerFeedbackDigest, getAnswerFeedbackFilterOptions } from './answer-feedback-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAnswerFeedbackDigest', () => {
  it('reads the digest for the query it is given', async () => {
    const body = { digest: null, error: 'digest_unavailable' }
    fetchMock.mockResolvedValueOnce(Response.json(body))

    await expect(getAnswerFeedbackDigest('days=7&locale=de')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/platform/answer-feedback/digest?days=7&locale=de')
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    const failure = await getAnswerFeedbackDigest('days=7').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 500 })
  })
})

describe('getAnswerFeedbackFilterOptions', () => {
  it('reads the filter options with the signal, so a superseded read can stop', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ organizations: [], projects: [] }))
    const controller = new AbortController()

    await getAnswerFeedbackFilterOptions('days=30', { signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledWith('/api/platform/answer-feedback/options?days=30', {
      signal: controller.signal,
    })
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }))

    const failure = await getAnswerFeedbackFilterOptions('days=30').catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 403 })
  })
})
