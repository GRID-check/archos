import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_REVISION_LINKS } from '@/lib/documents/revision-links'
import { RevisionRequestError, requestRevisionLink, setRevisionLink } from './revision-request'

const mockFetch = vi.fn()
const FACTS = {
  supersededBy: null,
  supersedes: [{ id: 'doc-a', filename: 'Grundriss_A.pdf' }],
  suggestion: null,
  changeSummary: null,
}

describe('revision-request', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs the older document and the flag to the newer one’s route', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: 'doc-b', revision: FACTS, older: { id: 'doc-a', revision: null } })))

    const facts = await setRevisionLink('doc-b', 'doc-a', true)

    expect(facts).toEqual(FACTS)
    expect(mockFetch).toHaveBeenCalledWith('/api/documents/doc-b/revision', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ older: 'doc-a', linked: true }),
    })
  })

  it('answers the facts of both documents', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: 'doc-b', revision: FACTS, older: { id: 'doc-a', revision: FACTS } })))

    expect(await requestRevisionLink('doc-b', 'doc-a', false)).toEqual({ newer: FACTS, older: FACTS })
  })

  it('reads a body without facts as nothing to say', async () => {
    mockFetch.mockResolvedValue(new Response('{}'))

    expect(await setRevisionLink('doc-b', 'doc-a', false)).toEqual(EMPTY_REVISION_LINKS)
  })

  it('throws the status of a refusal', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 403 }))

    await expect(setRevisionLink('doc-b', 'doc-a', true)).rejects.toMatchObject({ name: 'RevisionRequestError', status: 403 })
  })

  it('throws status 0 when nothing answered', async () => {
    mockFetch.mockRejectedValue(new TypeError('network'))

    const error = await setRevisionLink('doc-b', 'doc-a', true).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RevisionRequestError)
    expect((error as RevisionRequestError).status).toBe(0)
  })
})
