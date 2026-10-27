/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn(), lookupSubjectMembership: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ enabledFlagsForOrganization: vi.fn() }))
vi.mock('./person', () => ({ resolvePerson: vi.fn() }))
vi.mock('@/lib/authz/org-role-permissions', () => ({ rolePermissions: vi.fn() }))

import { rolePermissions } from '@/lib/authz/org-role-permissions'
import { lookupSubjectMembership, resolveSubjectMembership } from '@/lib/authz/project-membership'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { resolvePerson } from './person'
import { resolvePinnedRequesterSession, resolvePinnedRequesterSessionStrict } from './pinned-session'

const requester = { userId: 'user_owner', email: 'owner@grid.test', organizationId: 'org_1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member', roles: ['member'] })
  vi.mocked(lookupSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member', roles: ['member'] })
  vi.mocked(enabledFlagsForOrganization).mockResolvedValue([])
  vi.mocked(resolvePerson).mockResolvedValue({ name: null, email: null, organizationName: null })
  vi.mocked(rolePermissions).mockResolvedValue(new Set(['org:projects:create']))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolvePinnedRequesterSession', () => {
  it('builds the session the requester would have now, from their stored id alone', async () => {
    const session = await resolvePinnedRequesterSession(requester)

    expect(resolveSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner')
    expect(session).toMatchObject({
      userId: 'user_owner',
      email: 'owner@grid.test',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      roles: ['member'],
      // No token: nothing on the filing path forwards one, and none is minted.
      accessToken: '',
      featureFlags: [],
    })
    // Permissions come from WorkOS for the membership's roles, never from the caller.
    expect(rolePermissions).toHaveBeenCalledWith('org_1', ['member'])
    expect(session?.permissions).toEqual(['org:projects:create'])
  })

  it("gives an office's own custom role what WorkOS says it holds, as the person's token would", async () => {
    // Built from the catalog's table, the session gave a role the catalog has
    // never heard of nothing at all, so Piloti could not do for a Geschäftsführer
    // what the Geschäftsführer could do in the browser.
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1',
      role: 'org-geschaeftsfuehrung',
      roles: ['org-geschaeftsfuehrung'],
    })
    vi.mocked(rolePermissions).mockResolvedValueOnce(new Set(['org:projects:administer', 'org:settings:manage']))

    const session = await resolvePinnedRequesterSession(requester)

    expect(session?.permissions).toEqual(['org:projects:administer', 'org:settings:manage'])
  })

  it("carries every role's permissions, not only the primary one's", async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({
      organizationMembershipId: 'om_1',
      role: 'member',
      roles: ['member', 'org-site-lead'],
    })

    const session = await resolvePinnedRequesterSession(requester)

    expect(rolePermissions).toHaveBeenCalledWith('org_1', ['member', 'org-site-lead'])
    expect(session?.role).toBe('member')
    expect(session?.roles).toEqual(['member', 'org-site-lead'])
  })

  it('knows the person by name, as a live session does, so an unattended turn is not addressed as nobody', async () => {
    vi.mocked(resolvePerson).mockResolvedValueOnce({
      name: 'Anna Weber', email: 'anna@grid.test', organizationName: 'Atelier Nord',
    })

    const session = await resolvePinnedRequesterSession({ ...requester, email: null })

    expect(resolvePerson).toHaveBeenCalledWith('org_1', 'user_owner')
    // The stored email stands where the row has one; WorkOS fills it where it does not.
    expect(session).toMatchObject({ name: 'Anna Weber', email: 'anna@grid.test', organizationName: 'Atelier Nord' })
    expect((await resolvePinnedRequesterSession(requester))?.email).toBe('owner@grid.test')
  })

  it('is nobody when the requester left the organization', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce(null)

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it('is nobody when the membership carries no role to derive permissions from', async () => {
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce({ organizationMembershipId: 'om_1', role: null, roles: [] })

    expect(await resolvePinnedRequesterSession(requester)).toBeNull()
  })

  it("carries every flag of the requester's organization, asked by that organization", async () => {
    vi.mocked(enabledFlagsForOrganization).mockResolvedValueOnce(['agent-authored-documents', 'image-upload'])

    const session = await resolvePinnedRequesterSession(requester)
    expect(session?.featureFlags).toEqual(['agent-authored-documents', 'image-upload'])
    // The lookup that used to pass the slug as the organization.
    expect(enabledFlagsForOrganization).toHaveBeenCalledWith(requester.organizationId)
  })

  it('lets a failed flag lookup throw, so the background work retries instead of acting with none', async () => {
    vi.mocked(enabledFlagsForOrganization).mockRejectedValueOnce(new Error('workos down'))

    await expect(resolvePinnedRequesterSession(requester)).rejects.toThrow('workos down')
  })
})

describe('resolvePinnedRequesterSessionStrict', () => {
  it('builds the same session for a member', async () => {
    expect(await resolvePinnedRequesterSessionStrict(requester)).toMatchObject({ userId: 'user_owner', role: 'member' })
    expect(lookupSubjectMembership).toHaveBeenCalledWith('org_1', 'user_owner')
  })

  it('answers null only when WorkOS said the person is not a member', async () => {
    vi.mocked(lookupSubjectMembership).mockResolvedValueOnce(null)
    expect(await resolvePinnedRequesterSessionStrict(requester)).toBeNull()
  })

  it('throws when WorkOS could not be asked, so a caller does not act on "they left"', async () => {
    vi.mocked(lookupSubjectMembership).mockRejectedValueOnce(new Error('workos 503'))
    await expect(resolvePinnedRequesterSessionStrict(requester)).rejects.toThrow('workos 503')
  })
})
