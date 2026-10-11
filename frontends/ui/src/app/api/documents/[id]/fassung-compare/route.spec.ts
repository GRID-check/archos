/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/documents/fassung-compare-service', () => ({
  compareFassungVisually: vi.fn(),
}))

import { compareFassungVisually } from '@/lib/documents/fassung-compare-service'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import { POST } from './route'

const OLDER = '2f1c6e0e-4f0a-4c53-9a3e-0f2b7d8f6a11'

const call = (id: string, body: unknown) =>
  POST(
    new Request(`https://grid.test/api/documents/${id}/fassung-compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id }) },
  )

describe('POST /api/documents/[id]/fassung-compare', () => {
  beforeEach(() => vi.clearAllMocks())

  it('compares the older document with the one in the path and returns regions and summary', async () => {
    const answer = {
      regions: [{ page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'Tür neu' }],
      summary: ['Eine Tür ist neu.'],
    }
    vi.mocked(compareFassungVisually).mockResolvedValue(answer)

    const response = await call('doc-b', { older: OLDER, page: 2 })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(answer)
    expect(compareFassungVisually).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'doc-b', OLDER, 2)
  })

  it('takes page 1 when none is given', async () => {
    vi.mocked(compareFassungVisually).mockResolvedValue({ regions: [], summary: [] })

    expect((await call('doc-b', { older: OLDER })).status).toBe(200)
    expect(compareFassungVisually).toHaveBeenCalledWith(expect.anything(), 'doc-b', OLDER, 1)
  })

  it.each([
    ['no body fields', {}],
    ['an older id that is no uuid', { older: 'Grundriss_A.pdf', page: 1 }],
    ['page 0', { older: OLDER, page: 0 }],
    ['a fractional page', { older: OLDER, page: 1.5 }],
    ['page as text', { older: OLDER, page: 'x' }],
    ['a page past any drawing set', { older: OLDER, page: 100000 }],
  ])('rejects %s (zod) without calling the service', async (_name, body) => {
    expect((await call('doc-b', body)).status).toBe(400)
    expect(compareFassungVisually).not.toHaveBeenCalled()
  })

  it('maps the service’s refusals: 404 for a document not seen, 400 across collections, 409 for one not yet read', async () => {
    vi.mocked(compareFassungVisually).mockRejectedValueOnce(new NotFoundError())
    expect((await call('doc-b', { older: OLDER, page: 1 })).status).toBe(404)

    vi.mocked(compareFassungVisually).mockRejectedValueOnce(new BadRequestError('x', { reason: 'different_collection' }))
    expect((await call('doc-b', { older: OLDER, page: 1 })).status).toBe(400)

    vi.mocked(compareFassungVisually).mockRejectedValueOnce(new ConflictError('x', { reason: 'not_ingested' }))
    expect((await call('doc-b', { older: OLDER, page: 1 })).status).toBe(409)
  })
})
