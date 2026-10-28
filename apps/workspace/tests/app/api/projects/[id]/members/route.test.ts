/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: vi.fn(),
}))

// The roster resolves the project's FGA resource id from Postgres; here it is a fixed id.
vi.mock('@/lib/projects/repository', () => ({
  findProjectWorkosResourceId: vi.fn(),
}))

import { GET } from '@/app/api/projects/[id]/members/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectWorkosResourceId } from '@/lib/projects/repository'
import { getWorkOS } from '@/lib/workos/client'

const mockRequireAuthorizedSession = vi.mocked(requireAuthorizedSession)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockGetWorkOS = vi.mocked(getWorkOS)

const session = {
  userId: 'user_1',
  email: 'admin@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_admin',
  role: 'member',
  permissions: [] as string[],
  featureFlags: null,
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** WorkOS list calls resolve to an AutoPaginatable; the route drains it via autoPagination(). */
function paginated<T>(data: T[]): { autoPagination: () => Promise<T[]> } {
  return { autoPagination: () => Promise.resolve(data) }
}

describe('/api/projects/[id]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuthorizedSession.mockResolvedValue(session)
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-admin', closed: false, readsBecauseClosed: false })
    vi.mocked(findProjectWorkosResourceId).mockResolvedValue('res_1')
  })

  it('lists project-resource memberships by effective project permissions and merges user details', async () => {
    const listUsers = vi.fn().mockResolvedValue(
      paginated([
        {
          id: 'user_viewer',
          email: 'viewer@example.com',
          firstName: 'View',
          lastName: 'Only',
          name: null,
          profilePictureUrl: 'https://cdn.example.com/viewer.png',
        },
        {
          id: 'user_editor',
          email: 'editor@example.com',
          firstName: null,
          lastName: null,
          name: 'Editor Person',
          profilePictureUrl: null,
        },
        {
          id: 'user_admin',
          email: 'admin@example.com',
          firstName: 'Admin',
          lastName: 'Person',
          name: null,
          profilePictureUrl: 'https://cdn.example.com/admin.png',
        },
        {
          id: 'user_contributor',
          email: 'contributor@example.com',
          firstName: 'Con',
          lastName: 'Tributor',
          name: null,
          profilePictureUrl: null,
        },
        {
          id: 'user_narrow',
          email: 'narrow@example.com',
          firstName: null,
          lastName: null,
          name: 'Narrow Writer',
          profilePictureUrl: null,
        },
      ])
    )
    const listOrganizationMemberships = vi.fn().mockResolvedValue(
      paginated([
        { id: 'om_viewer', userId: 'user_viewer' },
        { id: 'om_editor', userId: 'user_editor' },
        { id: 'om_admin', userId: 'user_admin' },
        { id: 'om_contributor', userId: 'user_contributor' },
        { id: 'om_narrow', userId: 'user_narrow' },
      ])
    )
    // One list per rung of PROJECT_ROLE_BY_PERMISSION, in its order:
    // view, chat, edit, documents:write, memory:write, manage. A later rung
    // overwrites an earlier one, so each member reads as the strongest they hold.
    const everyone = [
      { id: 'om_viewer', userId: 'user_viewer' },
      { id: 'om_editor', userId: 'user_editor' },
      { id: 'om_admin', userId: 'user_admin' },
      { id: 'om_contributor', userId: 'user_contributor' },
      { id: 'om_narrow', userId: 'user_narrow' },
    ]
    const listMembershipsForResourceByExternalId = vi
      .fn()
      // project:view — everybody with any access at all
      .mockResolvedValueOnce(paginated(everyone))
      // project:chat — contributor, editor, admin
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
          { id: 'om_contributor', userId: 'user_contributor' },
        ])
      )
      // project:edit (the pre-split umbrella) — editor, admin
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
        ])
      )
      // project:documents:write — plus the custom narrow-write role, which the
      // old three-rung ladder reported as a plain Viewer
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
          { id: 'om_narrow', userId: 'user_narrow' },
        ])
      )
      // project:memory:write
      .mockResolvedValueOnce(
        paginated([
          { id: 'om_editor', userId: 'user_editor' },
          { id: 'om_admin', userId: 'user_admin' },
        ])
      )
      // project:manage
      .mockResolvedValueOnce(paginated([{ id: 'om_admin', userId: 'user_admin' }]))

    // The admin holds a stale viewer assignment besides the admin one: the row must offer
    // the assignment that grants the role it shows, not the first it finds. The others
    // reach the project through a group or an org-wide right: nothing to remove here.
    const listRoleAssignmentsForResource = vi.fn().mockResolvedValue(
      paginated([
        { id: 'ra_admin_old', organizationMembershipId: 'om_admin', role: { slug: 'project-viewer' } },
        { id: 'ra_admin', organizationMembershipId: 'om_admin', role: { slug: 'project-admin' } },
        { id: 'ra_viewer', organizationMembershipId: 'om_viewer', role: { slug: 'project-viewer' } },
      ])
    )

    mockGetWorkOS.mockReturnValue({
      userManagement: { listUsers, listOrganizationMemberships },
      authorization: { listMembershipsForResourceByExternalId, listRoleAssignmentsForResource },
    } as never)

    const res = await GET(
      new Request('http://localhost/api/projects/proj_1/members'),
      makeParams('proj_1')
    )

    expect(res.status).toBe(200)
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(session, 'proj_1', [
      'project:members:manage',
      'project:manage',
    ])
    expect(listRoleAssignmentsForResource).toHaveBeenCalledWith({ resourceId: 'res_1' })
    expect(listUsers).toHaveBeenCalledWith({ organizationId: 'org_1' })
    expect(listOrganizationMemberships).toHaveBeenCalledWith({ organizationId: 'org_1' })
    expect(listMembershipsForResourceByExternalId).toHaveBeenNthCalledWith(1, {
      organizationId: 'org_1',
      resourceTypeSlug: 'project',
      externalId: 'proj_1',
      permissionSlug: 'project:view',
      assignment: 'indirect',
    })
    const probed = listMembershipsForResourceByExternalId.mock.calls.map(
      (call) => (call[0] as { permissionSlug: string }).permissionSlug
    )
    // Every rung the catalog defines is probed. It used to be three, so a
    // Contributor read as "Viewer" and so did a role holding only the narrow
    // writes — on the one screen whose job is to report access accurately.
    expect(probed).toEqual([
      'project:view',
      'project:chat',
      'project:edit',
      'project:documents:write',
      'project:memory:write',
      'project:manage',
    ])

    await expect(res.json()).resolves.toEqual({
      members: [
        {
          organizationMembershipId: 'om_admin',
          userId: 'user_admin',
          email: 'admin@example.com',
          name: 'Admin Person',
          profilePictureUrl: 'https://cdn.example.com/admin.png',
          role: 'project-admin',
          roleAssignmentId: 'ra_admin',
        },
        {
          organizationMembershipId: 'om_contributor',
          userId: 'user_contributor',
          email: 'contributor@example.com',
          name: 'Con Tributor',
          profilePictureUrl: null,
          role: 'project-contributor',
          roleAssignmentId: null,
        },
        {
          organizationMembershipId: 'om_editor',
          userId: 'user_editor',
          email: 'editor@example.com',
          name: 'Editor Person',
          profilePictureUrl: null,
          role: 'project-editor',
          roleAssignmentId: null,
        },
        {
          organizationMembershipId: 'om_narrow',
          userId: 'user_narrow',
          email: 'narrow@example.com',
          name: 'Narrow Writer',
          profilePictureUrl: null,
          role: 'project-editor',
          roleAssignmentId: null,
        },
        {
          organizationMembershipId: 'om_viewer',
          userId: 'user_viewer',
          email: 'viewer@example.com',
          name: 'View Only',
          profilePictureUrl: 'https://cdn.example.com/viewer.png',
          role: 'project-viewer',
          roleAssignmentId: 'ra_viewer',
        }
      ],
      nextCursor: null,
      viewerUserId: 'user_1',
    })
  })

  it('answers one page with a nextCursor and, for scope=organization, people without a role', async () => {
    const people = ['a', 'b', 'c'].map((n) => ({ id: `u_${n}`, email: `${n}@x.de`, name: `P ${n}` }))
    mockGetWorkOS.mockReturnValue({
      userManagement: {
        listUsers: vi.fn().mockResolvedValue(paginated(people)),
        listOrganizationMemberships: vi
          .fn()
          .mockResolvedValue(paginated(people.map((p) => ({ id: `om_${p.id}`, userId: p.id })))),
      },
      authorization: {
        listMembershipsForResourceByExternalId: vi.fn().mockResolvedValue(paginated([])),
        listRoleAssignmentsForResource: vi.fn().mockResolvedValue(paginated([])),
      },
    } as never)

    const roleHolders = await GET(new Request('http://localhost/api/projects/proj_1/members'), makeParams('proj_1'))
    await expect(roleHolders.json()).resolves.toMatchObject({ members: [], nextCursor: null })

    const first = await GET(
      new Request('http://localhost/api/projects/proj_1/members?scope=organization&limit=2'),
      makeParams('proj_1')
    )
    const page = await first.json()
    expect(page.members.map((m: { userId: string }) => m.userId)).toEqual(['u_a', 'u_b'])
    expect(page.members[0]).toMatchObject({ role: null, roleAssignmentId: null })
    expect(page.nextCursor).toBe('2')

    const second = await GET(
      new Request(`http://localhost/api/projects/proj_1/members?scope=organization&limit=2&cursor=${page.nextCursor}`),
      makeParams('proj_1')
    )
    const last = await second.json()
    expect(last.members.map((m: { userId: string }) => m.userId)).toEqual(['u_c'])
    expect(last.nextCursor).toBeNull()
  })
})
