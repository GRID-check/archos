/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { Document } from '@/lib/db/schema/documents'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))

import { getAccessibleDocument } from './access'
import { changedRevisionPages, compareRevisionPage, compareRevisionVisually } from './revision-compare-service'
import { NO_VISIBLE_CHANGE } from './revision-compare-types'

const session = { userId: 'user-1', organizationId: 'org-1', email: 'a@b.test' } as AuthorizedSession

const doc = (overrides: Partial<Document>): Document =>
  ({
    id: 'doc-b',
    filename: 'Grundriss_B.pdf',
    collectionName: 'proj_abc',
    scope: 'project',
    projectId: 'p1',
    folderId: null,
    lifecycle: 'active',
    authoredBy: 'user',
    publishedVersionId: null,
    status: 'completed',
    screeningOutcome: 'clean',
    contentHash: 'h',
    screenedHash: 'h',
    createdBy: 'user-1',
    ...overrides,
  }) as Document

const NEWER = doc({ id: 'doc-b', filename: 'Grundriss_B.pdf' })
const OLDER = doc({ id: 'doc-a', filename: 'Grundriss_A.pdf' })

const REGION = { page: 1, x: 0.2, y: 0.3, w: 0.1, h: 0.25, label: 'Wand verschoben' }
const mockFetch = vi.fn()

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function documentsById(...docs: Document[]) {
  vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => {
    const found = docs.find((d) => d.id === id)
    if (!found) throw new NotFoundError()
    return found
  })
}

describe('compareRevisionVisually', () => {
  beforeEach(() => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'test-token')
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(answer({ regions: [REGION], summary: ['Die Wand ist nach Osten gerückt.'] }))
    vi.mocked(getAccessibleDocument).mockReset()
    documentsById(NEWER, OLDER)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('asks for READ access to both documents, tells the backend their file names and the page, and returns boxes and words', async () => {
    const result = await compareRevisionVisually(session, 'doc-b', 'doc-a', 2)

    expect(getAccessibleDocument).toHaveBeenCalledWith(session, 'doc-b', 'read')
    expect(getAccessibleDocument).toHaveBeenCalledWith(session, 'doc-a', 'read')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://backend:8000/v1/collections/proj_abc/revision-compare')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ older: 'Grundriss_A.pdf', newer: 'Grundriss_B.pdf', page: 2, purpose: 'person' })
    expect(init.headers).toMatchObject({ 'x-grid-organization-id': 'org-1', 'x-grid-user-id': 'user-1' })
    expect(result).toEqual({
      regions: [REGION],
      summary: ['Die Wand ist nach Osten gerückt.'],
      older_name: 'Grundriss_A.pdf',
      newer_name: 'Grundriss_B.pdf',
    })
  })

  it('encodes the collection name into the path', async () => {
    documentsById(doc({ id: 'doc-b', collectionName: 'archiv_org 1' }), doc({ id: 'doc-a', collectionName: 'archiv_org 1' }))

    await compareRevisionVisually(session, 'doc-b', 'doc-a', 1)

    expect(mockFetch.mock.calls[0][0]).toBe('http://backend:8000/v1/collections/archiv_org%201/revision-compare')
  })

  describe('privacy', () => {
    it.each([
      ['newer', 'doc-b'],
      ['older', 'doc-a'],
    ])('refuses a HELD %s document as not found, before anything is named to the backend', async (_side, heldId) => {
      documentsById(
        doc({ id: 'doc-b', filename: 'Grundriss_B.pdf', status: heldId === 'doc-b' ? 'quarantined' : 'completed' }),
        doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', status: heldId === 'doc-a' ? 'quarantined' : 'completed' }),
      )

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toBeInstanceOf(NotFoundError)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('refuses a document whose bytes changed after their screening', async () => {
      documentsById(NEWER, doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', contentHash: 'swapped' }))

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toBeInstanceOf(NotFoundError)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('refuses a document the caller may not see, whichever side it is on', async () => {
      documentsById(NEWER)
      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toBeInstanceOf(NotFoundError)

      documentsById(OLDER)
      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toBeInstanceOf(NotFoundError)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('lets the access gate refuse: a 403 from it reaches the caller and nothing is sent', async () => {
      vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toBeInstanceOf(ForbiddenError)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('refuses two documents of different collections', async () => {
      documentsById(NEWER, doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', collectionName: 'proj_other' }))

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toMatchObject({
        status: 400,
        details: { reason: 'different_collection' },
      })
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('refuses a restricted folder’s documents, which the backend never serves outside a chat turn', async () => {
      const restricted = 'proj_abc_r0123456789ab'
      documentsById(doc({ id: 'doc-b', collectionName: restricted }), doc({ id: 'doc-a', collectionName: restricted }))

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toMatchObject({
        status: 422,
        details: { reason: 'restricted_folder' },
      })
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('does not address a machine-authored row the backend holds nothing for', async () => {
      documentsById(NEWER, doc({ id: 'doc-a', filename: 'Bericht-2026-10-01.pdf', authoredBy: 'agent', status: 'completed' }))

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toBeInstanceOf(NotFoundError)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('what has no Fassungen', () => {
    it('refuses a document compared with itself', async () => {
      await expect(compareRevisionVisually(session, 'doc-b', 'doc-b', 1)).rejects.toMatchObject({
        details: { reason: 'same_document' },
      })
      expect(getAccessibleDocument).not.toHaveBeenCalled()
    })

    it('refuses a chat attachment and an archived document', async () => {
      documentsById(NEWER, doc({ id: 'doc-a', scope: 'session' }))
      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toMatchObject({
        details: { reason: 'session_document' },
      })

      documentsById(NEWER, doc({ id: 'doc-a', lifecycle: 'archived' }))
      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toMatchObject({
        details: { reason: 'archived' },
      })
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('the backend’s answer', () => {
    it.each([
      [404, 404],
      [409, 409],
      [400, 400],
      [422, 400],
      [503, 503],
      [500, 502],
      [502, 502],
    ])('maps its %i to %i', async (backendStatus, status) => {
      mockFetch.mockResolvedValue(answer({ detail: 'x' }, backendStatus))

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toMatchObject({ status })
    })

    it('says a document not yet read is a conflict with its reason', async () => {
      mockFetch.mockResolvedValue(answer({ detail: 'x' }, 409))

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toMatchObject({
        details: { reason: 'not_ingested' },
      })
    })

    it('is a 502 when the backend cannot be reached', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

      await expect(compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).rejects.toMatchObject({ status: 502 })
    })

    it('drops a box that is not a box and keeps the words', async () => {
      mockFetch.mockResolvedValue(
        answer({
          regions: [REGION, { ...REGION, x: 4 }, { ...REGION, w: 0 }, { ...REGION, label: '' }, 'x', null],
          summary: ['Satz', '', 3],
        }),
      )

      expect(await compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).toEqual({
        regions: [REGION],
        summary: ['Satz'],
        older_name: 'Grundriss_A.pdf',
        newer_name: 'Grundriss_B.pdf',
      })
    })

    it('reads a reply with nothing in it as „keine sichtbare Änderung“', async () => {
      mockFetch.mockResolvedValue(answer({ regions: [], summary: [] }))
      expect(await compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).toEqual({
        regions: [],
        summary: [NO_VISIBLE_CHANGE],
        older_name: 'Grundriss_A.pdf',
        newer_name: 'Grundriss_B.pdf',
      })

      mockFetch.mockResolvedValue(new Response('not json', { status: 200 }))
      expect(await compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).toEqual({
        regions: [],
        summary: [NO_VISIBLE_CHANGE],
        older_name: 'Grundriss_A.pdf',
        newer_name: 'Grundriss_B.pdf',
      })
    })

    it('keeps at most twelve boxes', async () => {
      mockFetch.mockResolvedValue(answer({ regions: Array.from({ length: 30 }, () => REGION), summary: ['s'] }))

      expect((await compareRevisionVisually(session, 'doc-b', 'doc-a', 1)).regions).toHaveLength(12)
    })
  })
})

describe('compareRevisionPage (a notice, ADR-0130)', () => {
  const TRACE = 'a'.repeat(32)

  beforeEach(() => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'test-token')
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    vi.mocked(getAccessibleDocument).mockReset()
    documentsById(NEWER, OLDER)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('says it is a notice and keeps the trace of the call; the browser path never sees it', async () => {
    mockFetch.mockResolvedValue(answer({ regions: [REGION], summary: ['s'], trace_id: TRACE }))

    const result = await compareRevisionPage(session, 'doc-b', 'doc-a', 3, 'notice')

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ page: 3, purpose: 'notice' })
    expect(result.traceId).toBe(TRACE)
    expect(await compareRevisionVisually(session, 'doc-b', 'doc-a', 3)).not.toHaveProperty('traceId')
  })

  it('reads a malformed trace id as none', async () => {
    mockFetch.mockResolvedValue(answer({ regions: [], summary: [], trace_id: 'not-a-trace' }))

    expect((await compareRevisionPage(session, 'doc-b', 'doc-a', 1, 'notice')).traceId).toBeNull()
  })
})

describe('changedRevisionPages', () => {
  beforeEach(() => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'test-token')
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockReset()
    vi.mocked(getAccessibleDocument).mockReset()
    documentsById(NEWER, OLDER)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('asks the index under the same checks, and keeps only real page numbers', async () => {
    mockFetch.mockResolvedValue(answer({ pages: [2, 0, 'x', 5.5, 7], newer_page_count: 9, comparable: true }))

    const result = await changedRevisionPages(session, 'doc-b', 'doc-a')

    expect(mockFetch.mock.calls[0][0]).toBe('http://backend:8000/v1/collections/proj_abc/revision-pages')
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ older: 'Grundriss_A.pdf', newer: 'Grundriss_B.pdf' })
    expect(result).toEqual({ pages: [2, 7], newerPageCount: 9, comparable: true })
  })

  it('refuses a restricted folder before the backend is asked', async () => {
    documentsById(doc({ id: 'doc-b', collectionName: 'proj_abc_r0123456789ab' }), doc({ id: 'doc-a', collectionName: 'proj_abc_r0123456789ab' }))

    await expect(changedRevisionPages(session, 'doc-b', 'doc-a')).rejects.toMatchObject({ status: 422 })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
