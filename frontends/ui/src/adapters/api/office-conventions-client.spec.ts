/**
 * @vitest-environment node
 *
 * The URL, method and body the office conventions client puts on the wire, and
 * the status it surfaces. The card shows a failed load as an error state and a
 * failed decision as a toast, so the status must reach the caller intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { decideOfficeConvention, getOfficeConventions } from './office-conventions-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getOfficeConventions', () => {
  it('reads the conventions from the office route', async () => {
    const view = { enabled: true, lines: [] }
    fetchMock.mockResolvedValueOnce(Response.json(view))

    await expect(getOfficeConventions()).resolves.toEqual(view)
    expect(fetchMock).toHaveBeenCalledWith('/api/organization/office-conventions')
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))

    const failure = await getOfficeConventions().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 500 })
  })
})

describe('decideOfficeConvention', () => {
  it('POSTs the line and the decision as JSON', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ enabled: true, lines: [] }))

    await decideOfficeConvention('line-1', 'confirmed')

    expect(fetchMock).toHaveBeenCalledWith('/api/organization/office-conventions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineKey: 'line-1', decision: 'confirmed' }),
    })
  })

  it('answers the view with the decision applied', async () => {
    const view = { enabled: true, lines: [{ key: 'line-1' }] }
    fetchMock.mockResolvedValueOnce(Response.json(view))

    await expect(decideOfficeConvention('line-1', 'declined')).resolves.toEqual(view)
  })

  it('surfaces a failed decision with its status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 422 }))

    const failure = await decideOfficeConvention('line-1', 'undecided').catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 422 })
  })
})
