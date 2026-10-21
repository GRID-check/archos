/**
 * @vitest-environment node
 *
 * `mail-import-part-upload` (ADR-0121): the raw part the dispatcher sends from an agent's base64
 * body is read by this route as the browser's part is: the bytes as the body, their length
 * stated, the part number from the path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findOperation } from '@/lib/agent-api/catalog'
import { callOperation } from '@/lib/agent-api/dispatch'

vi.mock('@/lib/mail-import/service', () => ({ putMailImportPart: vi.fn() }))

import { putMailImportPart } from '@/lib/mail-import/service'

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('mail-import-part-upload', () => {
  it('hands the service the ids, the part number and a request carrying the bytes', async () => {
    let received = ''
    let length: string | null = null
    let type: string | null = null
    vi.mocked(putMailImportPart).mockImplementation(async (_session, _project, _import, partNumber, request) => {
      received = await request.text()
      length = request.headers.get('content-length')
      type = request.headers.get('content-type')
      return { partNumber }
    })
    const op = findOperation('mail-import-part-upload')
    if (!op) throw new Error('mail-import-part-upload is not in the catalog')

    const result = await callOperation(
      op,
      {
        params: { id: 'proj-1', importId: 'imp-1', partNumber: '3' },
        body: { contentBase64: Buffer.from('archive-bytes').toString('base64') },
      },
      session,
    )

    expect(result.body).toEqual({ partNumber: 3 })
    expect(putMailImportPart).toHaveBeenCalledWith(expect.anything(), 'proj-1', 'imp-1', 3, expect.any(Request))
    expect(received).toBe('archive-bytes')
    expect(length).toBe('13')
    expect(type).toBe('application/octet-stream')
  })
})
