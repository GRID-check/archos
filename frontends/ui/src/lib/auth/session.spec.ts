/**
 * @vitest-environment node
 *
 * Where a live session's flag set is assembled (ADR-0102): the entitlements
 * from the signed WorkOS claim, the rollouts from PostHog per organization. The
 * gates downstream read one array synchronously, so this is the one place the
 * two sources meet for a person who is signed in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const withAuth = vi.fn()
vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: () => withAuth(),
  getTokenClaims: async () => ({}),
}))

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    userManagement: { listOrganizationMemberships: async () => ({ data: [{ id: 'om_1' }] }) },
  }),
}))

vi.mock('./membership-roles', () => ({ resolveMembershipRoles: async () => ['member'] }))
vi.mock('@/lib/db/tenant-context', () => ({ enterTenantContext: vi.fn(), clearTenantContext: vi.fn() }))

const getAllFlags = vi.fn()
vi.mock('@/lib/analytics/posthog-server', () => ({ getPosthogServer: () => ({ getAllFlags }) }))

import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { _clearRolloutFlagCache } from '@/lib/analytics/rollout-flags'
import { getGridSession } from './session'

function signedIn(featureFlags: string[] | undefined, organizationId: string | null = 'org_1') {
  withAuth.mockResolvedValue({
    user: { id: 'user_1', email: 'a@b.test', firstName: 'A', lastName: 'B' },
    accessToken: 'token',
    organizationId,
    role: 'member',
    permissions: [],
    featureFlags,
  })
}

beforeEach(async () => {
  vi.stubEnv('REQUIRE_AUTH', 'true')
  getAllFlags.mockReset()
  getAllFlags.mockResolvedValue({})
  await _clearRolloutFlagCache('org_1')
})

describe('getGridSession: the session flag set', () => {
  it('carries an entitlement from the claim and a rollout from PostHog', async () => {
    signedIn([FEATURE_FLAGS.skills])
    getAllFlags.mockResolvedValue({ 'image-upload': false })

    const session = await getGridSession()

    expect(isFeatureEnabled(session!, FEATURE_FLAGS.skills)).toBe(true)
    expect(isFeatureEnabled(session!, FEATURE_FLAGS.webSearch)).toBe(true)
    expect(isFeatureEnabled(session!, FEATURE_FLAGS.imageUpload)).toBe(false)
    expect(getAllFlags).toHaveBeenCalledWith('org:org_1', expect.anything())
  })

  it('ignores a rollout the WorkOS claim still carries, once PostHog says off', async () => {
    signedIn([FEATURE_FLAGS.ifcModels])
    getAllFlags.mockResolvedValue({ 'ifc-models': false })

    const session = await getGridSession()

    expect(isFeatureEnabled(session!, FEATURE_FLAGS.ifcModels)).toBe(false)
  })

  it('gives a stale token no entitlement, and its rollouts all the same', async () => {
    signedIn(undefined)

    const session = await getGridSession()

    expect(session?.featureFlags).not.toBeNull()
    expect(isFeatureEnabled(session!, FEATURE_FLAGS.deepResearch)).toBe(false)
    expect(isFeatureEnabled(session!, FEATURE_FLAGS.agentAuthoredDocuments)).toBe(true)
  })

  it('does not ask PostHog for a session without an organization, and keeps rollouts on', async () => {
    signedIn([], null)

    const session = await getGridSession()

    expect(isFeatureEnabled(session!, FEATURE_FLAGS.webSearch)).toBe(true)
    expect(getAllFlags).not.toHaveBeenCalled()
  })
})
