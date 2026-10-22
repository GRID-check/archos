/**
 * @vitest-environment node
 *
 * `document-upload` (ADR-0122): the multipart form the dispatcher builds from an
 * agent's base64 body is accepted by this route's own parser, field for field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callOperation } from '@/lib/agent-api/dispatch'
import { findOperation } from '@/lib/agent-api/catalog'

vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))

import { uploadDocument } from '@/lib/documents/service'

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
const BATCH = '2f6c3b1e-0d3a-4d2e-9a53-6d1f9d6c2b11'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadDocument).mockResolvedValue({ documentId: 'd1', jobId: null, status: 'uploaded', filename: 'Plan.pdf' })
})

describe('document-upload', () => {
  it('hands the route its file and every field it reads', async () => {
    const op = findOperation('document-upload')
    if (!op) throw new Error('document-upload is not in the catalog')
    const result = await callOperation(
      op,
      {
        body: {
          files: [{ name: 'Plan.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF fake').toString('base64') }],
          fields: { projectId: 'proj-1', folderId: 'fold-1', originPath: 'EG/Plan.pdf', screeningRelease: 'name', uploadBatchId: BATCH },
        },
      },
      session,
    )

    expect(result.status).toBe(200)
    expect(uploadDocument).toHaveBeenCalledTimes(1)
    const input = vi.mocked(uploadDocument).mock.calls[0]?.[1]
    expect(input).toMatchObject({
      projectId: 'proj-1',
      folderId: 'fold-1',
      originPath: 'EG/Plan.pdf',
      screeningRelease: true,
      uploadBatchId: BATCH,
      revisionOf: null,
    })
    expect(input?.file.name).toBe('Plan.pdf')
    expect(await input?.file.text()).toBe('%PDF fake')
  })

  it('is refused before the route runs when projectId is missing', async () => {
    const op = findOperation('document-upload')
    if (!op) throw new Error('document-upload is not in the catalog')
    await expect(
      callOperation(op, { body: { files: [{ name: 'a.pdf', contentBase64: 'YQ==' }], fields: {} } }, session),
    ).rejects.toThrow(/projectId/)
    expect(uploadDocument).not.toHaveBeenCalled()
  })
})
