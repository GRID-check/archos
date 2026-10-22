/**
 * @vitest-environment node
 */
/**
 * `/api/organization/office-conventions` — any member reads the lines, only an
 * `org:settings:manage` holder decides one: a decision changes what Piloti says
 * to everyone in the organization.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'admin@example.test',
  role: 'member',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/office-conventions/service', async () => {
  const { NotFoundError } = await import('@/lib/api/errors')
  class UnknownConventionLineError extends NotFoundError {}
  return {
    UnknownConventionLineError,
    listOfficeConventions: vi.fn().mockResolvedValue({ enabled: true, projects: 4, computedAt: null, lines: [] }),
    decideOfficeConvention: vi.fn().mockImplementation(async (_org: string, _user: string, input: { lineKey: string }) => {
      if (input.lineKey === 'nope') throw new UnknownConventionLineError('no such line')
    }),
  }
})

import { decideOfficeConvention, listOfficeConventions } from '@/lib/office-conventions/service'
import { GET, POST } from './route'

const post = (body: unknown): Request =>
  new Request('http://localhost/api/organization/office-conventions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/organization/office-conventions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.permissions = []
  })

  it('GET lets any member read the lines, keyed by the session’s organization', async () => {
    const res = await GET(new Request('http://localhost/api/organization/office-conventions'))
    expect(res.status).toBe(200)
    expect((await res.json()).projects).toBe(4)
    expect(listOfficeConventions).toHaveBeenCalledWith('org-1')
  })

  it('POST refuses a member without org:settings:manage, before anything is written', async () => {
    const res = await post({ lineKey: 'folder:behörde', decision: 'declined' })
    expect((await POST(res)).status).toBe(403)
    expect(decideOfficeConvention).not.toHaveBeenCalled()
  })

  it('POST records the decision as the caller and returns the updated list', async () => {
    session.permissions = ['org:settings:manage']
    const res = await POST(post({ lineKey: 'folder:behörde', decision: 'confirmed' }))
    expect(res.status).toBe(200)
    expect(decideOfficeConvention).toHaveBeenCalledWith('org-1', 'user-1', { lineKey: 'folder:behörde', decision: 'confirmed' })
    expect((await res.json()).lines).toEqual([])
  })

  it('POST answers 404 for a line the office does not have', async () => {
    session.permissions = ['org:settings:manage']
    expect((await POST(post({ lineKey: 'nope', decision: 'declined' }))).status).toBe(404)
  })

  it('POST refuses a decision it does not know, with a 400', async () => {
    session.permissions = ['org:settings:manage']
    expect((await POST(post({ lineKey: 'folder:behörde', decision: 'maybe' }))).status).toBe(400)
    expect((await POST(post({ decision: 'confirmed' }))).status).toBe(400)
    expect(decideOfficeConvention).not.toHaveBeenCalled()
  })
})
