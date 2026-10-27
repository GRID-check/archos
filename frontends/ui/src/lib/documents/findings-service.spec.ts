import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { encodeDocumentLevelCursor } from './list-cursor'
import type { ListedDocument } from './shelf-listing'

vi.mock('server-only', () => ({}))
const listDocumentsPage = vi.fn()
vi.mock('./service', () => ({ listDocumentsPage: (...args: unknown[]) => listDocumentsPage(...args) }))

const { getProjectDocumentFindings } = await import('./findings-service')

const session = { organizationId: 'org-1', userId: 'user-1' } as unknown as AuthorizedSession
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

const NEXT = encodeDocumentLevelCursor({ sort: 'added', dir: 'desc', value: '2026-10-01T00:00:00.000000', id: ID_A })

const row = (overrides: Partial<ListedDocument>): ListedDocument =>
  ({ id: ID_A, filename: 'a.pdf', displayName: null, tags: null, revision: null, ...overrides }) as ListedDocument

describe('getProjectDocumentFindings', () => {
  beforeEach(() => listDocumentsPage.mockReset())

  it('reads the shelf through the listing, page after page, and resolves the asked document', async () => {
    listDocumentsPage
      .mockResolvedValueOnce({
        documents: [
          row({
            id: ID_A,
            filename: 'Baubeschreibung.pdf',
            docReferences: [{ kind: 'plan', key: 'ep-05', label: 'EP-05', pages: [2] }],
          }),
        ],
        nextCursor: NEXT,
      })
      .mockResolvedValueOnce({
        documents: [row({ id: ID_B, filename: 'EP-05 Grundriss EG.pdf', displayName: 'Grundriss EG' })],
        nextCursor: null,
      })

    const result = await getProjectDocumentFindings(session, 'project-1', ID_A)

    expect(listDocumentsPage).toHaveBeenCalledTimes(2)
    expect(listDocumentsPage.mock.calls[1][2].level.cursor).toBeDefined()
    expect(result.documentCount).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.findings).toEqual([])
    expect(result.document?.references[0]).toMatchObject({
      resolution: 'resolved',
      targets: [{ documentId: ID_B, name: 'Grundriss EG' }],
    })
  })

  it('reads a document the listing did not hand this reader as none', async () => {
    listDocumentsPage.mockResolvedValueOnce({ documents: [row({})], nextCursor: null })
    const result = await getProjectDocumentFindings(session, 'project-1', ID_B)
    expect(result.document).toBeNull()
  })

  it('takes a document replaced by a newer Fassung as superseded', async () => {
    const facts = (value: string) => ({
      documentType: null,
      title: null,
      summary: null,
      parties: [],
      dates: [],
      place: null,
      facts: [{ key: 'units' as const, value, unit: null, page: 1, quote: null }],
    })
    listDocumentsPage.mockResolvedValueOnce({
      documents: [
        row({ id: ID_A, dossier: facts('12'), revision: { supersededBy: { id: ID_B } } as ListedDocument['revision'] }),
        row({ id: ID_B, filename: 'b.pdf', dossier: facts('14') }),
      ],
      nextCursor: null,
    })
    expect((await getProjectDocumentFindings(session, 'project-1')).findings).toEqual([])
  })

  it('stops after its page bound and says so', async () => {
    listDocumentsPage.mockResolvedValue({ documents: [row({})], nextCursor: NEXT })
    const result = await getProjectDocumentFindings(session, 'project-1')
    expect(listDocumentsPage).toHaveBeenCalledTimes(4)
    expect(result.truncated).toBe(true)
  })
})
