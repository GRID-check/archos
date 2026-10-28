/**
 * @vitest-environment node
 *
 * The URLs and the query the knowledge client puts on the wire, and the status
 * it surfaces. The RIS reader shows a 429 as "busy" and every other failure as
 * unavailable, so the status must reach the caller intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiRequestError } from './api-error'
import { getKnowledgeBase, getRisDocument } from './knowledge-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getKnowledgeBase', () => {
  it('reads the base corpus status', async () => {
    const status = { collectionName: 'base', files: [] }
    fetchMock.mockResolvedValueOnce(Response.json(status))

    await expect(getKnowledgeBase()).resolves.toEqual(status)
    expect(fetchMock).toHaveBeenCalledWith('/api/knowledge-base')
  })

  it('throws the typed error with the status when the read fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }))

    const failure = await getKnowledgeBase().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 503 })
  })
})

describe('getRisDocument', () => {
  const document = { url: 'https://ris', title: 'ABGB', text: 'Text', truncated: false }

  it('asks for the reference alone when there is no passage', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(document))

    await expect(getRisDocument('ref-1')).resolves.toEqual(document)
    expect(fetchMock).toHaveBeenCalledWith('/api/ris/document?reference=ref-1')
  })

  it('sends the passage with the reference when there is one', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(document))

    await getRisDocument('ref-1', 'Der Vertrag')

    expect(fetchMock).toHaveBeenCalledWith('/api/ris/document?reference=ref-1&passage=Der+Vertrag')
  })

  it('treats an empty passage as no passage', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(document))

    await getRisDocument('ref-1', '')

    expect(fetchMock).toHaveBeenCalledWith('/api/ris/document?reference=ref-1')
  })

  it('surfaces a rate limit with its 429 status, which the reader shows as busy', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }))

    const failure = await getRisDocument('ref-1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect(failure).toMatchObject({ status: 429 })
  })
})
