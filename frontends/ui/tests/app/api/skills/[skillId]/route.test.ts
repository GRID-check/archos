/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/skills/service', () => ({
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}))

import { DELETE, PATCH } from '@/app/api/skills/[skillId]/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { deleteSkill, updateSkill } from '@/lib/skills/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Skill } from '@/lib/db/schema'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockUpdate = vi.mocked(updateSkill)
const mockDelete = vi.mocked(deleteSkill)

const asSkill = (row: Pick<Skill, 'id' | 'name'>): Skill => row as unknown as Skill

const session: Omit<AuthorizedSession, 'featureFlags'> & { featureFlags: string[] | null } = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

// Next 15 route handlers receive params as a Promise; the route awaits it.
const context = { params: Promise.resolve({ skillId: 'skill-1' }) }

function req(body?: unknown): Request {
  return new Request('http://localhost/api/skills/skill-1', {
    method: body ? 'PATCH' : 'DELETE',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // A signed-in deployment: the session's WorkOS claim is the skills gate, and
  // a session without the claim is the default (off).
  vi.stubEnv('REQUIRE_AUTH', 'true')
  session.featureFlags = null
  mockSession.mockResolvedValue(session as unknown as AuthorizedSession)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PATCH /api/skills/[skillId]', () => {
  it('returns 403 feature-disabled when the skills gate is off (default)', async () => {
    session.featureFlags = []
    const res = await PATCH(req({ description: 'New.' }), context)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature-disabled', feature: 'skills' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('patches the org skill when the skills flag is on', async () => {
    session.featureFlags = ['skills']
    mockUpdate.mockResolvedValue({ skill: asSkill({ id: 'skill-1', name: 'a' }) })
    const res = await PATCH(req({ description: 'New.' }), context)
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith(session, 'skill-1', { description: 'New.' })
  })

  it('rejects an invalid name with 400 without reaching the service', async () => {
    session.featureFlags = ['skills']
    const res = await PATCH(req({ name: 'UPPER CASE' }), context)
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/skills/[skillId]', () => {
  it('returns 403 feature-disabled when the skills gate is off', async () => {
    session.featureFlags = []
    const res = await DELETE(req(), context)
    expect(res.status).toBe(403)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes the org skill when the skills flag is on', async () => {
    session.featureFlags = ['skills']
    mockDelete.mockResolvedValue({ deleted: true })
    const res = await DELETE(req(), context)
    expect(res.status).toBe(204)
    expect(mockDelete).toHaveBeenCalledWith(session, 'skill-1')
  })
})
