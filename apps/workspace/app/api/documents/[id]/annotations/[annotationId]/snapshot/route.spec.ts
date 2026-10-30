/**
 * @vitest-environment node
 */
/** `GET …/annotations/{annotationId}/snapshot`: the image as bytes with its own type, never cached by a shared cache, and the service's 404 as a 404. */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_anna',
    organizationId: 'org_1',
    email: 'anna@buero.test',
    name: 'Anna Berger',
    role: 'member',
    permissions: [],
  }),
}))
vi.mock('@/lib/annotations/viewpoint-read', () => ({ readViewpointSnapshot: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { readViewpointSnapshot } from '@/lib/annotations/viewpoint-read'
import { GET } from './route'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

const call = () =>
  GET(new Request('https://grid.test/api/documents/doc_1/annotations/ann_1/snapshot'), {
    params: Promise.resolve({ id: 'doc_1', annotationId: 'ann_1' }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readViewpointSnapshot).mockResolvedValue({ bytes: PNG, contentType: 'image/png' })
})

describe('GET /api/documents/[id]/annotations/[annotationId]/snapshot', () => {
  it('serves the bytes with the stored type, private and sniff-proof', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
    expect(readViewpointSnapshot).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_anna' }), 'doc_1', 'ann_1')
  })

  it('answers 404 when the mark has no snapshot or the reader may not open the document', async () => {
    vi.mocked(readViewpointSnapshot).mockRejectedValue(new NotFoundError())
    expect((await call()).status).toBe(404)
  })
})
