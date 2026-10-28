/**
 * @vitest-environment node
 */
/**
 * The estate tree route is a thin adapter, and what is its own to hold is the
 * identity: the service token AND a verified envelope, the acting person the
 * envelope's (a pinned session), the tenant the envelope's, and a body that
 * cannot name a project, a collection or an organization.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))
vi.mock('@/lib/estate-tree/service', () => ({
  readEstateTree: vi.fn(async () => ({
    shelf: 'project',
    collection: 'proj_1',
    folders: [],
    folders_truncated: false,
    documents: [],
    next_cursor: null,
  })),
}))

import { NotFoundError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { withTenant } from '@/lib/db/tenant-context'
import { readEstateTree } from '@/lib/estate-tree/service'
import { buildRequestContextEnvelope, REQUEST_CONTEXT_HEADER_NAMES } from '@/lib/request-context'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const PROJECT = '33333333-3333-4333-8333-333333333333'

const session = {
  userId: 'user_requester',
  email: 'r@example.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member' as const,
  permissions: [],
  featureFlags: null,
}

function envelopeHeaders(secret = SECRET) {
  const { header, signature } = buildRequestContextEnvelope(
    {
      organizationId: 'org_1',
      userId: 'user_requester',
      projectId: PROJECT,
      conversationId: 's_conv_1',
      collectionScope: ['oib_knowledge', 'proj_1'],
      issuedAt: Date.now(),
    },
    secret,
  )
  return { [REQUEST_CONTEXT_HEADER_NAMES.REQUEST_CONTEXT]: header, [REQUEST_CONTEXT_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '' }
}

function request(body: unknown, headers: Record<string, string> = envelopeHeaders(), token: string | null = SECRET) {
  return new Request('https://grid.test/api/internal/estate-tree', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}), ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('INTERNAL_API_TOKEN', SECRET)
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
})

describe('POST /api/internal/estate-tree', () => {
  it('reads as the pinned session, in the envelope’s tenant, with the envelope’s project and scope', async () => {
    const response = await POST(request({ shelf: 'project', limit: 50 }))

    expect(response.status).toBe(200)
    expect(vi.mocked(readEstateTree)).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', userId: 'user_requester', projectId: PROJECT, conversationId: 's_conv_1', collectionScope: ['oib_knowledge', 'proj_1'] }),
      session,
      { shelf: 'project', limit: 50 },
    )
    expect(vi.mocked(withTenant)).toHaveBeenCalledWith({ organizationId: 'org_1', userId: 'user_requester' }, expect.any(Function))
  })

  it('refuses the token alone, a wrong token, and an envelope signed with another secret', async () => {
    expect((await POST(request({ shelf: 'project' }, {}))).status).toBe(401)
    expect((await POST(request({ shelf: 'project' }, envelopeHeaders(), 'wrong'))).status).toBe(403)
    expect((await POST(request({ shelf: 'project' }, envelopeHeaders('other-secret')))).status).toBe(401)
    expect(vi.mocked(readEstateTree)).not.toHaveBeenCalled()
  })

  it('refuses a person who is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    expect((await POST(request({ shelf: 'project' }))).status).toBe(403)
    expect(vi.mocked(readEstateTree)).not.toHaveBeenCalled()
  })

  it.each([
    ['another organization', { shelf: 'project', organization_id: 'org_2' }],
    ['a project', { shelf: 'project', project_id: PROJECT }],
    ['a restricted collection', { shelf: 'project', collection: 'proj_1_r0123456789ab' }],
    ['a page past the bound', { shelf: 'project', limit: 501 }],
    ['a shelf the estate has not', { shelf: 'law' }],
  ])('400s a body naming %s before reading anything', async (_name, body) => {
    expect((await POST(request(body))).status).toBe(400)
    expect(vi.mocked(readEstateTree)).not.toHaveBeenCalled()
  })

  it('passes a refusal on as the 404 a missing folder gets', async () => {
    vi.mocked(readEstateTree).mockRejectedValueOnce(new NotFoundError('No folder with that path.'))
    const response = await POST(request({ shelf: 'project', folder_path: 'Personal' }))
    expect(response.status).toBe(404)
  })
})
