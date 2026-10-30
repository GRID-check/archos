/**
 * @vitest-environment node
 */
/** `POST …/annotations` bounds its body before it parses it: a snapshot-sized body goes through, a larger one is a 413 and reaches no service. */

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
vi.mock('@/lib/annotations/service', async (original) => ({
  ...(await original<typeof import('@/lib/annotations/service')>()),
  createAnnotation: vi.fn(),
  listAnnotations: vi.fn(),
}))

import { createAnnotation } from '@/lib/annotations/service'
import { MAX_CREATE_BODY_BYTES } from '@/lib/annotations/viewpoint-types'
import { POST } from './route'

const post = (body: string) =>
  POST(
    new Request('https://grid.test/api/documents/doc_1/annotations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ id: 'doc_1' }) }
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createAnnotation).mockResolvedValue({ annotation: {} } as never)
})

describe('POST /api/documents/[id]/annotations body size', () => {
  it('reads a body within the bound', async () => {
    const body = JSON.stringify({ page: 1, shape: 'point', x: 0.1, y: 0.1, kind: 'hint', body: 'x' })
    expect((await post(body)).status).toBe(201)
    expect(createAnnotation).toHaveBeenCalled()
  })

  it('answers 413 for a body over the bound, before parsing or calling the service', async () => {
    const response = await post(JSON.stringify({ body: 'x'.repeat(MAX_CREATE_BODY_BYTES) }))
    expect(response.status).toBe(413)
    expect(createAnnotation).not.toHaveBeenCalled()
  })
})
