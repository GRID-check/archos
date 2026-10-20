/**
 * @vitest-environment node
 *
 * The Archiv upload takes the same two optional fields a project's does
 * (ADR-0078): `folderId`, the Archiv folder to file into, and `originPath`,
 * where a folder upload found the file.
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
vi.mock('@/lib/office-shelf/service', () => ({ uploadOfficeShelfDocument: vi.fn() }))

import { uploadOfficeShelfDocument } from '@/lib/office-shelf/service'
import { POST } from './route'

const post = (fields: Record<string, string>) => {
  const form = new FormData()
  form.set('file', new File(['x'], 'plan.pdf', { type: 'application/pdf' }))
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return POST(new NextRequest('https://grid.test/api/archiv/documents/upload', { method: 'POST', body: form }), {
    params: Promise.resolve({}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadOfficeShelfDocument).mockResolvedValue({
    documentId: 'd1',
    jobId: null,
    status: 'uploaded',
    filename: 'plan.pdf',
  })
})

describe('POST /api/archiv/documents/upload', () => {
  it('files into the named folder and passes the origin path on', async () => {
    const response = await post({ folderId: 'folder-1', originPath: 'Normen/plan.pdf' })

    expect(response.status).toBe(200)
    expect(uploadOfficeShelfDocument).toHaveBeenCalledWith(expect.anything(), expect.any(File), expect.any(Request), {
      folderId: 'folder-1',
      originPath: 'Normen/plan.pdf',
      screeningRelease: false,
      uploadBatchId: null,
      fassungOf: null,
    })
  })

  it('uploads to the Archiv root when no folder is named', async () => {
    await post({ folderId: '' })

    expect(uploadOfficeShelfDocument).toHaveBeenCalledWith(expect.anything(), expect.any(File), expect.any(Request), {
      folderId: null,
      originPath: null,
      screeningRelease: false,
      uploadBatchId: null,
      fassungOf: null,
    })
  })

  it('passes on the document the reader filed it as the new Fassung of', async () => {
    const older = '0b8f3c1e-0d3a-4d2e-9a53-6d1f9d6c2b11'
    await post({ fassungOf: older })

    expect(uploadOfficeShelfDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(File),
      expect.any(Request),
      expect.objectContaining({ fassungOf: older }),
    )
  })

  it('refuses a revision-of value that is not a document id', async () => {
    const response = await post({ fassungOf: 'Grundriss_EG_Index_B.pdf' })

    expect(response.status).toBe(400)
    expect(uploadOfficeShelfDocument).not.toHaveBeenCalled()
  })

  it('refuses a request with no file', async () => {
    const response = await POST(
      new NextRequest('https://grid.test/api/archiv/documents/upload', { method: 'POST', body: new FormData() }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
  })
})
