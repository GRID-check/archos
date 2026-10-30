/**
 * @vitest-environment node
 */
/** `GET …/annotations/{annotationId}/viewpoint`: the service's answer as JSON, its 404 for a reader or a mark that is not there as a 404. */

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
vi.mock('@/lib/annotations/viewpoint-read', () => ({ readViewpoint: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { readViewpoint } from '@/lib/annotations/viewpoint-read'
import { GET } from './route'

const VIEWPOINT = {
  id: 'vp_1',
  documentId: 'doc_1',
  versionId: null,
  camera: {
    type: 'perspective' as const,
    position: { x: 1, y: 2, z: 3 },
    direction: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    fieldOfView: 60,
    aspectRatio: 1.5,
  },
  clippingPlanes: [],
  components: { selection: { globalIds: [] }, visibility: { defaultVisibility: true, exceptions: [] }, coloring: [] },
  pin: null,
  hasSnapshot: false,
  createdAt: '2026-10-30T08:00:00.000Z',
}

const call = () =>
  GET(new Request('https://grid.test/api/documents/doc_1/annotations/ann_1/viewpoint'), {
    params: Promise.resolve({ id: 'doc_1', annotationId: 'ann_1' }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readViewpoint).mockResolvedValue({ viewpoint: VIEWPOINT })
})

describe('GET /api/documents/[id]/annotations/[annotationId]/viewpoint', () => {
  it('reads the viewpoint for the caller’s session, the document and the mark in the path', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ viewpoint: VIEWPOINT })
    expect(readViewpoint).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_anna' }), 'doc_1', 'ann_1')
  })

  it('answers 404 when the service does: a document the reader may not open, or a mark with no viewpoint', async () => {
    vi.mocked(readViewpoint).mockRejectedValue(new NotFoundError())
    expect((await call()).status).toBe(404)
  })
})
