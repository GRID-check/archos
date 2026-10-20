/**
 * @vitest-environment node
 *
 * The project upload takes the older document's id when the reader filed the
 * file as its new Fassung (ADR-0099), and refuses anything that is not an id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
    permissions: [],
    featureFlags: null,
  }),
}))
vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))

import { uploadDocument } from '@/lib/documents/service'
import { POST } from './route'

const OLDER = '0b8f3c1e-0d3a-4d2e-9a53-6d1f9d6c2b11'

const post = (fields: Record<string, string>) => {
  const form = new FormData()
  form.set('file', new File(['x'], 'EG_Grundriss_Index_C.pdf', { type: 'application/pdf' }))
  form.set('projectId', 'proj-1')
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return POST(new NextRequest('https://grid.test/api/documents/upload', { method: 'POST', body: form }), {
    params: Promise.resolve({}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadDocument).mockResolvedValue({ documentId: 'd1', jobId: null, status: 'uploaded', filename: 'x.pdf' })
})

describe('POST /api/documents/upload — revision link', () => {
  it('passes the older document’s id to the service, which checks it', async () => {
    const response = await post({ revisionOf: OLDER })

    expect(response.status).toBe(200)
    expect(uploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'proj-1', revisionOf: OLDER }),
      expect.any(Request),
    )
  })

  it('sends none for an upload nobody filed as a Fassung', async () => {
    await post({})

    expect(uploadDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ revisionOf: null }), expect.any(Request))
  })

  it('refuses a revision-of value that is a file name, before anything is stored', async () => {
    const response = await post({ revisionOf: 'EG_Grundriss_Index_B.pdf' })

    expect(response.status).toBe(400)
    expect(uploadDocument).not.toHaveBeenCalled()
  })
})
