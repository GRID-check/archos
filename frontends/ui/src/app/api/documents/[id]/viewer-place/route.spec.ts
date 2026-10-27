/**
 * @vitest-environment node
 */
/**
 * The gate a viewer action passes before it moves the person's screen
 * (ADR-0141): the document read as the person, the older Fassung on its shelf.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'member',
  }),
}))
vi.mock('@/lib/documents/listed-document', () => ({ getListedDocument: vi.fn() }))
vi.mock('@/lib/documents/lifecycle', () => ({
  summarizeDocumentVersions: vi.fn().mockResolvedValue(new Map()),
}))

import { getListedDocument } from '@/lib/documents/listed-document'
import type { ListedDocument } from '@/lib/documents/shelf-listing'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { GET } from './route'

const listed = (id: string, collectionName = 'proj_c', projectId: string | null = 'proj-1') =>
  ({
    id,
    filename: `${id}.pdf`,
    displayName: null,
    fileSize: 10,
    contentType: 'application/pdf',
    status: 'completed',
    authoredBy: 'user',
    publishedVersionId: null,
    lifecycle: 'active',
    collectionName,
    folderId: null,
    originPath: null,
    contentHash: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    errorMessage: null,
    quarantine: null,
    assignees: [],
    projectId,
  }) as ListedDocument & { projectId: string | null }

const read = (id: string, against?: string) =>
  GET(
    new Request(`https://grid.test/api/documents/${id}/viewer-place${against ? `?against=${against}` : ''}`) as unknown as NextRequest,
    { params: Promise.resolve({ id }) }
  )

describe('GET /api/documents/[id]/viewer-place', () => {
  beforeEach(() => vi.clearAllMocks())

  it('answers with the row the person may open, read in their session', async () => {
    vi.mocked(getListedDocument).mockResolvedValue(listed('doc-1'))

    const response = await read('doc-1')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.document).toMatchObject({ id: 'doc-1', projectId: 'proj-1' })
    expect(body).not.toHaveProperty('against')
    expect(getListedDocument).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'doc-1')
  })

  it.each([
    ['not found', new NotFoundError()],
    ['forbidden', new ForbiddenError()],
  ])('refuses a document the person may not see (%s), so nothing moves', async (_, error) => {
    vi.mocked(getListedDocument).mockRejectedValue(error)
    expect([403, 404]).toContain((await read('held-1')).status)
  })

  it('refuses a comparison when the older Fassung is not theirs to see', async () => {
    vi.mocked(getListedDocument).mockImplementation(async (_session, id) => {
      if (id === 'doc-1') return listed('doc-1')
      throw new NotFoundError()
    })
    expect((await read('doc-1', 'secret-0')).status).toBe(404)
  })

  it('refuses a pair from two shelves: that is no comparison', async () => {
    vi.mocked(getListedDocument).mockImplementation(async (_session, id) =>
      id === 'doc-1' ? listed('doc-1') : listed(id, 'archiv_c', null)
    )
    expect((await read('doc-1', 'doc-0')).status).toBe(404)
  })

  it('answers both Fassungen of one shelf', async () => {
    vi.mocked(getListedDocument).mockImplementation(async (_session, id) => listed(id))

    const body = await (await read('doc-1', 'doc-0')).json()

    expect([body.document.id, body.against.id]).toEqual(['doc-1', 'doc-0'])
  })
})
