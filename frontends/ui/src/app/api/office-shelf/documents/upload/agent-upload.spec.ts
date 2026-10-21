/**
 * @vitest-environment node
 *
 * `office-shelf-document-upload` (ADR-0121): the multipart form the dispatcher builds from an
 * agent's base64 body is accepted by this route's own parser, field for field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findOperation } from '@/lib/agent-api/catalog'
import { callOperation } from '@/lib/agent-api/dispatch'

vi.mock('@/lib/office-shelf/service', () => ({ uploadOfficeShelfDocument: vi.fn() }))

import { uploadOfficeShelfDocument } from '@/lib/office-shelf/service'

const session = {
  userId: 'user-1',
  email: 'test@grid.com',
  name: null,
  accessToken: '',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}
const OLDER = '0b8f3c1e-0d3a-4d2e-9a53-6d1f9d6c2b11'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadOfficeShelfDocument).mockResolvedValue({
    documentId: 'd1',
    jobId: null,
    status: 'uploaded',
    filename: 'Norm.pdf',
  })
})

describe('office-shelf-document-upload', () => {
  it('hands the route its file and every field it reads', async () => {
    const op = findOperation('office-shelf-document-upload')
    if (!op) throw new Error('office-shelf-document-upload is not in the catalog')
    const result = await callOperation(
      op,
      {
        body: {
          files: [{ name: 'Norm.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF fake').toString('base64') }],
          fields: { folderId: 'fold-1', originPath: 'Normen/Norm.pdf', revisionOf: OLDER },
        },
      },
      session,
    )

    expect(result.status).toBe(200)
    const [, file, , options] = vi.mocked(uploadOfficeShelfDocument).mock.calls[0] ?? []
    expect(file?.name).toBe('Norm.pdf')
    expect(await file?.text()).toBe('%PDF fake')
    expect(options).toMatchObject({
      folderId: 'fold-1',
      originPath: 'Normen/Norm.pdf',
      screeningRelease: false,
      uploadBatchId: null,
      revisionOf: OLDER,
    })
  })

  it('takes the file alone, with no fields', async () => {
    const op = findOperation('office-shelf-document-upload')
    if (!op) throw new Error('office-shelf-document-upload is not in the catalog')
    await callOperation(op, { body: { files: [{ name: 'a.pdf', contentBase64: 'YQ==' }] } }, session)
    expect(vi.mocked(uploadOfficeShelfDocument).mock.calls[0]?.[3]).toMatchObject({ folderId: null, originPath: null })
  })
})
