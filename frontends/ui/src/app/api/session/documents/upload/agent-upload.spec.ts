/**
 * @vitest-environment node
 *
 * `session-document-upload` (ADR-0121): the multipart form the dispatcher builds from an
 * agent's base64 body is accepted by this route's own parser, field for field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findOperation } from '@/lib/agent-api/catalog'
import { callOperation } from '@/lib/agent-api/dispatch'

vi.mock('@/lib/session-documents/service', () => ({ uploadSessionDocument: vi.fn() }))

import { uploadSessionDocument } from '@/lib/session-documents/service'

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
const CONVERSATION = 's_0b8f3c1e_0d3a_4d2e_9a53_6d1f9d6c2b11'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadSessionDocument).mockResolvedValue({
    documentId: 'd1',
    jobId: null,
    status: 'uploaded',
    filename: 'Notiz.txt',
  } as Awaited<ReturnType<typeof uploadSessionDocument>>)
})

describe('session-document-upload', () => {
  it('hands the route its file, the conversation and the optional fields', async () => {
    const op = findOperation('session-document-upload')
    if (!op) throw new Error('session-document-upload is not in the catalog')
    const result = await callOperation(
      op,
      {
        body: {
          files: [{ name: 'Notiz.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hallo').toString('base64') }],
          fields: { conversationId: CONVERSATION, projectId: 'proj-1' },
        },
      },
      session,
    )

    expect(result.status).toBe(200)
    const input = vi.mocked(uploadSessionDocument).mock.calls[0]?.[1]
    expect(input).toMatchObject({ conversationId: CONVERSATION, projectId: 'proj-1', screeningRelease: false, uploadBatchId: null })
    expect(input?.file.name).toBe('Notiz.txt')
    expect(await input?.file.text()).toBe('hallo')
  })

  it('is refused before the route runs without a conversationId', async () => {
    const op = findOperation('session-document-upload')
    if (!op) throw new Error('session-document-upload is not in the catalog')
    await expect(callOperation(op, { body: { files: [{ name: 'a.txt', contentBase64: 'YQ==' }], fields: {} } }, session)).rejects.toThrow(
      /conversationId/,
    )
    expect(uploadSessionDocument).not.toHaveBeenCalled()
  })
})
