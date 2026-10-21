/**
 * @vitest-environment node
 *
 * `platform-knowledge-document-upload` (ADR-0121): the multipart form the dispatcher builds from
 * an agent's base64 body is accepted by this route's own parser, field for field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findOperation } from '@/lib/agent-api/catalog'
import { callOperation } from '@/lib/agent-api/dispatch'

vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return { PlatformAccessDeniedError, requirePlatformPermission: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('@/lib/knowledge/service', () => ({ uploadKnowledgeBaseDocument: vi.fn() }))

import { uploadKnowledgeBaseDocument } from '@/lib/knowledge/service'

const session = {
  userId: 'user-1',
  email: 'test@grid.com',
  name: null,
  accessToken: '',
  organizationId: 'org-platform',
  organizationMembershipId: 'om-1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadKnowledgeBaseDocument).mockResolvedValue({ status: 'pending' } as Awaited<
    ReturnType<typeof uploadKnowledgeBaseDocument>
  >)
})

describe('platform-knowledge-document-upload', () => {
  it('hands the route its file and doc_class', async () => {
    const op = findOperation('platform-knowledge-document-upload')
    if (!op) throw new Error('platform-knowledge-document-upload is not in the catalog')
    const result = await callOperation(
      op,
      {
        body: {
          files: [{ name: 'OIB-RL-2.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF fake').toString('base64') }],
          fields: { doc_class: 'richtlinie' },
        },
      },
      session,
    )

    expect(result.status).toBe(200)
    const [file, options] = vi.mocked(uploadKnowledgeBaseDocument).mock.calls[0] ?? []
    expect(file?.name).toBe('OIB-RL-2.pdf')
    expect(await file?.text()).toBe('%PDF fake')
    expect(options).toEqual({ docClass: 'richtlinie' })
  })

  it('takes the file alone', async () => {
    const op = findOperation('platform-knowledge-document-upload')
    if (!op) throw new Error('platform-knowledge-document-upload is not in the catalog')
    await callOperation(op, { body: { files: [{ name: 'a.pdf', contentBase64: 'YQ==' }] } }, session)
    expect(vi.mocked(uploadKnowledgeBaseDocument).mock.calls[0]?.[1]).toEqual({ docClass: undefined })
  })
})
