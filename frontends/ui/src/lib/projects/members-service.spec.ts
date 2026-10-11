/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '@/lib/api/errors'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./repository', () => ({
  findProjectWorkosResourceId: vi.fn().mockResolvedValue('res_project_1'),
}))

const steckbrief = vi.hoisted(() => ({ recordMemberLeft: vi.fn(), recordMemberRejoined: vi.fn() }))
vi.mock('./steckbrief-service', () => steckbrief)

vi.mock('@/lib/collaboration/cleanup', () => ({
  revokeCollaborationForProjectMember: vi.fn().mockResolvedValue(undefined),
}))

const getOrganizationMembership = vi.fn(async (id: string) => ({ id, userId: `user_of_${id}` }))
const listRoleAssignmentsForResource = vi.fn()
const removeRoleAssignment = vi.fn().mockResolvedValue(undefined)
const assignRole = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    authorization: {
      listRoleAssignmentsForResource,
      removeRoleAssignment,
      assignRole,
    },
    userManagement: { getOrganizationMembership },
  }),
}))

import { setProjectMemberRole, removeProjectRoleAssignment } from './members-service'

type Assignment = { id: string; organizationMembershipId: string; role: { slug: string }; createdAt?: string }

const session = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'admin@grid.com',
} as never

const request = new Request('https://grid.test/api/projects/p1/members', { method: 'POST' })

/** Stub the FGA assignment list the service reads to count admins. */
function stubAssignments(assignments: Assignment[]): void {
  listRoleAssignmentsForResource.mockResolvedValue({
    autoPagination: () => Promise.resolve(assignments),
  })
}

const admin = (id: string, membershipId: string): Assignment => ({
  id,
  organizationMembershipId: membershipId,
  role: { slug: 'project-admin' },
})
const editor = (id: string, membershipId: string): Assignment => ({
  id,
  organizationMembershipId: membershipId,
  role: { slug: 'project-editor' },
})

beforeEach(() => {
  listRoleAssignmentsForResource.mockReset()
  removeRoleAssignment.mockClear()
  assignRole.mockClear()
  steckbrief.recordMemberLeft.mockClear()
  steckbrief.recordMemberRejoined.mockClear()
})

describe('setProjectMemberRole — last-admin guard', () => {
  it('rejects demoting the only admin (self-demotion)', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), editor('ra_2', 'om_editor')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: 'project-editor' },
        request
      )
    ).rejects.toBeInstanceOf(ConflictError)

    // The guard runs before any mutation.
    expect(removeRoleAssignment).not.toHaveBeenCalled()
    expect(assignRole).not.toHaveBeenCalled()
  })

  it('rejects removing (no access) the only admin', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: '' },
        request
      )
    ).rejects.toBeInstanceOf(ConflictError)
    expect(removeRoleAssignment).not.toHaveBeenCalled()
  })

  it('carries the last-admin marker so the client can localize it', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await setProjectMemberRole(
      session,
      'p1',
      { organizationMembershipId: 'om_admin', roleSlug: '' },
      request
    ).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).details).toEqual({ reason: 'last-admin' })
    })
    expect.assertions(2)
  })

  it('allows demoting an admin when another admin remains', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), admin('ra_2', 'om_admin2')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: 'project-editor' },
        request
      )
    ).resolves.toBeUndefined()

    expect(removeRoleAssignment).toHaveBeenCalledTimes(1)
    expect(assignRole).toHaveBeenCalledTimes(1)
  })

  it('allows re-granting admin to the same sole admin', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_admin', roleSlug: 'project-admin' },
        request
      )
    ).resolves.toBeUndefined()
    expect(assignRole).toHaveBeenCalledTimes(1)
  })

  it('does not block changing a non-admin member', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), editor('ra_2', 'om_editor')])

    await expect(
      setProjectMemberRole(
        session,
        'p1',
        { organizationMembershipId: 'om_editor', roleSlug: 'project-viewer' },
        request
      )
    ).resolves.toBeUndefined()
  })
})

describe('removeProjectRoleAssignment — last-admin guard', () => {
  it('rejects removing the only admin assignment', async () => {
    stubAssignments([admin('ra_1', 'om_admin')])

    await expect(
      removeProjectRoleAssignment(session, 'p1', 'ra_1', request)
    ).rejects.toBeInstanceOf(ConflictError)
    expect(removeRoleAssignment).not.toHaveBeenCalled()
  })

  it('allows removing an admin assignment when another admin remains', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), admin('ra_2', 'om_admin2')])

    await expect(
      removeProjectRoleAssignment(session, 'p1', 'ra_1', request)
    ).resolves.toBeUndefined()
    expect(removeRoleAssignment).toHaveBeenCalledTimes(1)
  })
})

describe('the Steckbrief keeps who worked on the project (ADR-0091)', () => {
  const dated = (assignment: Assignment, createdAt: string): Assignment => ({ ...assignment, createdAt })

  it('someone taken off the project stays on as a former member, from the month they joined', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), dated(editor('ra_2', 'om_editor'), '2024-02-14T10:00:00Z')])
    await setProjectMemberRole(session, 'p1', { organizationMembershipId: 'om_editor', roleSlug: '' }, request)
    expect(steckbrief.recordMemberLeft).toHaveBeenCalledWith(session, 'p1', { userId: 'user_of_om_editor', since: '2024-02' })
    expect(steckbrief.recordMemberRejoined).not.toHaveBeenCalled()
  })

  it('a role change is no leaving, and putting someone back makes them current again', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), editor('ra_2', 'om_editor')])
    await setProjectMemberRole(session, 'p1', { organizationMembershipId: 'om_editor', roleSlug: 'project-viewer' }, request)
    expect(steckbrief.recordMemberLeft).not.toHaveBeenCalled()
    expect(steckbrief.recordMemberRejoined).not.toHaveBeenCalled()

    await setProjectMemberRole(session, 'p1', { organizationMembershipId: 'om_new', roleSlug: 'project-editor' }, request)
    expect(steckbrief.recordMemberRejoined).toHaveBeenCalledWith(session, 'p1', 'user_of_om_new')
  })

  it('removing an assignment keeps the member only when it was their last on the project', async () => {
    stubAssignments([admin('ra_1', 'om_admin'), editor('ra_2', 'om_editor'), editor('ra_3', 'om_editor')])
    await removeProjectRoleAssignment(session, 'p1', 'ra_2', request)
    expect(steckbrief.recordMemberLeft).not.toHaveBeenCalled()

    stubAssignments([admin('ra_1', 'om_admin'), dated(editor('ra_3', 'om_editor'), '2025-01-05T08:00:00Z')])
    await removeProjectRoleAssignment(session, 'p1', 'ra_3', request)
    expect(steckbrief.recordMemberLeft).toHaveBeenCalledWith(session, 'p1', { userId: 'user_of_om_editor', since: '2025-01' })
  })
})
