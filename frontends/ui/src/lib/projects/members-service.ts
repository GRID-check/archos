/**
 * Project members service — the WorkOS FGA roster and role assignments for a
 * project. Owns authorization (`project:manage` for every operation) and the
 * audit trail for access-control changes. Route handlers stay thin: they
 * validate input shape and delegate here.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { requireProjectAccess, type ProjectPermission } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { pageOfList, type OffsetPage } from '@/lib/api/offset-page'
import { revokeCollaborationForProjectMember } from '@/lib/collaboration/cleanup'
import type { AuthorizedSession } from '@/lib/auth/types'
import { dateToMonth, type Month } from './month'
import { findProjectWorkosResourceId } from './repository'
import { recordMemberLeft, recordMemberRejoined } from './project-record-service'

/**
 * The project roles a member can be assigned, exactly as the catalog defines
 * them. `project-contributor` belongs here even though `requireProjectAccess`'s
 * derived ladder does not distinguish it (see `ProjectRole` there): this is what
 * WorkOS holds and what the roster shows, and leaving it out is why the role
 * shipped assignable-in-theory and unassignable-in-practice.
 */
export type ProjectMemberRole =
  | 'project-viewer'
  | 'project-contributor'
  | 'project-editor'
  | 'project-admin'

const PROJECT_ADMIN_ROLE_SLUG = 'project-admin'

/** Machine-readable marker so the client can localize the last-admin block. */
const LAST_ADMIN_DETAILS = { reason: 'last-admin' } as const

/**
 * The distinct organization-membership ids that currently hold `project-admin`
 * on a resource, derived from the FGA role assignments the caller already
 * listed. A `Set` because a membership can appear more than once (e.g. direct
 * plus group-derived) and each counts as a single admin.
 */
function adminMembershipIds(
  assignments: Array<{ organizationMembershipId: string; role: { slug: string } }>
): Set<string> {
  return new Set(
    assignments
      .filter((assignment) => assignment.role.slug === PROJECT_ADMIN_ROLE_SLUG)
      .map((assignment) => assignment.organizationMembershipId)
  )
}

/**
 * Last-admin invariant. A role change or removal that strips `project-admin`
 * from `targetMembershipId` is rejected when no OTHER membership would still be
 * an admin — a project must never be left with zero admins and no in-app way to
 * recover. `willRemainAdmin` is true only when the pending change re-grants
 * `project-admin` to the same target. Covers both self-demotion and demoting
 * the only other admin. Cheap: it reuses the assignment list already fetched,
 * adding no WorkOS round-trip.
 */
function assertNotLastAdmin(
  assignments: Array<{ organizationMembershipId: string; role: { slug: string } }>,
  targetMembershipId: string,
  willRemainAdmin: boolean
): void {
  if (willRemainAdmin) return
  const admins = adminMembershipIds(assignments)
  if (!admins.has(targetMembershipId)) return
  const otherAdmins = [...admins].filter((id) => id !== targetMembershipId)
  if (otherAdmins.length === 0) {
    throw new ConflictError(
      'This project must keep at least one admin. Assign another admin before removing this one.',
      LAST_ADMIN_DETAILS
    )
  }
}

/**
 * Permission → displayed role, as an ORDERED ladder: the roster probes each
 * permission and a later match overwrites an earlier one, so the strongest rung
 * a member reaches is the one shown.
 *
 * Every rung the catalog defines has an entry, which it did not before. Probing
 * only `view`/`edit`/`manage` meant a Contributor displayed as "Viewer" (it
 * holds `project:view` and nothing further down the old ladder) and a custom
 * role built the way the catalog recommends — narrow writes, no umbrella —
 * displayed as "Viewer" too. A roster that under-reports somebody's access is
 * worse than no roster: it is the screen an admin uses to audit exactly that.
 *
 * The two narrow writes both map to Editor because that is the rung, not because
 * they are interchangeable; `project:edit` stays for roles provisioned before
 * the ADR-0038 split.
 */
const PROJECT_ROLE_BY_PERMISSION: Array<{
  permissionSlug: ProjectPermission
  role: ProjectMemberRole
}> = [
  { permissionSlug: 'project:view', role: 'project-viewer' },
  { permissionSlug: 'project:chat', role: 'project-contributor' },
  { permissionSlug: 'project:edit', role: 'project-editor' },
  { permissionSlug: 'project:documents:write', role: 'project-editor' },
  { permissionSlug: 'project:memory:write', role: 'project-editor' },
  { permissionSlug: 'project:manage', role: 'project-admin' },
]

export interface ProjectMember {
  organizationMembershipId: string
  userId: string
  email: string | null
  profilePictureUrl: string | null
  name: string
  role: ProjectMemberRole | null
  /**
   * The WorkOS role assignment that grants `role` directly: what
   * `removeProjectRoleAssignment` takes. Null for a member without a project
   * role, and for one who reaches the project only through a group or an
   * organization-wide right (nothing to remove here).
   */
  roleAssignmentId: string | null
}

/** Who a roster lists: the people holding a project role, or the whole organization (to pick whom to add). */
export type ProjectMemberScope = 'members' | 'organization'

/**
 * The project roster: by default the people who hold a project role, each with
 * their effective role and the assignment id that removes it. `scope:
 * 'organization'` is the whole organization, role null for those without one
 * (the form that picks whom to add). Ordered by name, one page at a time.
 */
export async function listProjectMembers(
  session: AuthorizedSession,
  projectId: string,
  options: { scope?: ProjectMemberScope; page?: OffsetPage } = {}
): Promise<{ members: ProjectMember[]; nextCursor: string | null }> {
  await requireProjectAccess(session, projectId, ['project:members:manage', 'project:manage'])
  const scope = options.scope ?? 'members'
  const workosResourceId = await findProjectWorkosResourceId(projectId, session.organizationId)

  const workos = getWorkOS()

  // WorkOS list endpoints return 10 items per page by default; autoPagination
  // walks every page so rosters larger than one page aren't silently truncated.
  // Every list is independent — fetch them in parallel. This is the one screen
  // in the product whose whole job is to report access accurately, so it probes
  // each rung rather than inferring one from another.
  const [users, orgMemberships, assignments, ...membershipLists] = await Promise.all([
    workos.userManagement
      .listUsers({ organizationId: session.organizationId })
      .then((page) => page.autoPagination()),
    workos.userManagement
      .listOrganizationMemberships({ organizationId: session.organizationId })
      .then((page) => page.autoPagination()),
    workosResourceId
      ? workos.authorization
          .listRoleAssignmentsForResource({ resourceId: workosResourceId })
          .then((page) => page.autoPagination())
      : Promise.resolve([]),
    ...PROJECT_ROLE_BY_PERMISSION.map(({ permissionSlug }) =>
      workos.authorization
        .listMembershipsForResourceByExternalId({
          organizationId: session.organizationId,
          resourceTypeSlug: 'project',
          externalId: projectId,
          permissionSlug,
          assignment: 'indirect',
        })
        .then((page) => page.autoPagination())
    ),
  ])

  const projectMemberByUserId = new Map<
    string,
    { organizationMembershipId: string; userId: string; role: ProjectMemberRole }
  >()

  const organizationMembersByUserId = new Map(
    orgMemberships.map((membership) => [membership.userId, membership])
  )

  membershipLists.forEach((memberships, index) => {
    const role = PROJECT_ROLE_BY_PERMISSION[index].role
    for (const membership of memberships) {
      const organizationMembership = organizationMembersByUserId.get(membership.userId)
      projectMemberByUserId.set(membership.userId, {
        organizationMembershipId: organizationMembership?.id ?? membership.id,
        userId: membership.userId,
        role,
      })
    }
  })

  const userById = new Map(users.map((user) => [user.id, user]))
  // Keyed by membership and role slug: the assignment that grants the role the
  // row shows is the one to offer for removal, not whichever came first.
  const assignmentByMembershipAndRole = new Map<string, string>()
  for (const assignment of assignments) {
    const key = `${assignment.organizationMembershipId}:${assignment.role.slug}`
    if (!assignmentByMembershipAndRole.has(key)) assignmentByMembershipAndRole.set(key, assignment.id)
  }

  const rows = orgMemberships.map((organizationMembership) => {
    const user = userById.get(organizationMembership.userId)
    const projectMembership = projectMemberByUserId.get(organizationMembership.userId)
    return {
      organizationMembershipId: organizationMembership.id,
      userId: organizationMembership.userId,
      email: user?.email ?? null,
      profilePictureUrl: user?.profilePictureUrl ?? null,
      name:
        user?.name ||
        (user?.firstName
          ? `${user.firstName} ${user.lastName ?? ''}`.trim()
          : user?.lastName || user?.email || organizationMembership.userId),
      role: projectMembership?.role ?? null,
      roleAssignmentId: projectMembership
        ? (assignmentByMembershipAndRole.get(`${organizationMembership.id}:${projectMembership.role}`) ?? null)
        : null,
    }
  })

  const listed = (scope === 'members' ? rows.filter((row) => row.role !== null) : rows).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  const { rows: members, nextCursor } = pageOfList(listed, options.page ?? { limit: listed.length || 1, offset: 0 })
  return { members, nextCursor }
}

/**
 * Set (or clear, with an empty roleSlug) a member's project role. Existing
 * assignments for the membership are removed first so a member never holds
 * two project roles at once. Access-control change — always audited.
 */
export async function setProjectMemberRole(
  session: AuthorizedSession,
  projectId: string,
  input: { organizationMembershipId: string; roleSlug: ProjectMemberRole | '' },
  request: Request
): Promise<void> {
  await requireProjectAccess(session, projectId, ['project:members:manage', 'project:manage'])

  const workosResourceId = await findProjectWorkosResourceId(projectId, session.organizationId)
  if (!workosResourceId) throw new NotFoundError('Project resource not found.')

  const { organizationMembershipId, roleSlug } = input
  const workos = getWorkOS()

  const assignments = await workos.authorization
    .listRoleAssignmentsForResource({ resourceId: workosResourceId })
    .then((page) => page.autoPagination())

  // Reject any change that would drop the project's admin count to zero
  // (ADR-0017: the service owns the invariant). Re-granting admin to the same
  // target keeps them an admin, so it's always allowed.
  assertNotLastAdmin(assignments, organizationMembershipId, roleSlug === PROJECT_ADMIN_ROLE_SLUG)

  const held = assignments.filter((assignment) => assignment.organizationMembershipId === organizationMembershipId)
  await Promise.all(
    held
      .map((assignment) =>
        workos.authorization.removeRoleAssignment({
          organizationMembershipId,
          roleAssignmentId: assignment.id,
        })
      )
  )

  if (roleSlug) {
    await workos.authorization.assignRole({
      organizationMembershipId,
      resourceExternalId: projectId,
      resourceTypeSlug: 'project',
      roleSlug,
    })
  }

  // The Steckbrief keeps who worked on the project (ADR-0091): someone taken
  // off it stays on as a former member, someone put back is current again.
  if (!roleSlug && held.length > 0) {
    await keepDepartedMember(session, projectId, organizationMembershipId, earliestMonth(held))
  } else if (roleSlug && held.length === 0) {
    const userId = await userOfMembership(organizationMembershipId)
    if (userId) await recordMemberRejoined(session, projectId, userId)
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: roleSlug ? 'project.role.assigned' : 'project.role.removed',
    targetType: 'project',
    targetId: projectId,
    metadata: { organizationMembershipId, roleSlug: roleSlug || 'none' },
    request,
  })
}

/**
 * Remove a single WorkOS FGA role assignment from a project. Walks every
 * assignment page so assignments beyond the first page are found too.
 * Access-control change — always audited.
 */
export async function removeProjectRoleAssignment(
  session: AuthorizedSession,
  projectId: string,
  assignmentId: string,
  request: Request
): Promise<void> {
  await requireProjectAccess(session, projectId, ['project:members:manage', 'project:manage'])

  const workosResourceId = await findProjectWorkosResourceId(projectId, session.organizationId)
  if (!workosResourceId) throw new NotFoundError()

  const workos = getWorkOS()
  const assignments = await workos.authorization
    .listRoleAssignmentsForResource({ resourceId: workosResourceId })
    .then((page) => page.autoPagination())

  const assignment = assignments.find((a) => a.id === assignmentId)
  if (!assignment) throw new NotFoundError()

  // A bare assignment removal is also a demotion — hold the last-admin line.
  assertNotLastAdmin(assignments, assignment.organizationMembershipId, false)

  await workos.authorization.removeRoleAssignment({
    organizationMembershipId: assignment.organizationMembershipId,
    roleAssignmentId: assignment.id,
  })

  // Losing project access ends effective access to every conversation inside it
  // (spec SH-4/SH-13), so collaboration state that depends on this person being
  // able to READ those threads has to be settled now. Otherwise a thread waiting
  // on them waits forever: they can no longer open it, so they can never answer.
  // Grants are deliberately kept — they are inert while the container is
  // unreachable, so re-adding the person restores their previous sharing state.
  // Best-effort: an access-control change must not fail on notification bookkeeping.
  const userId = await userOfMembership(assignment.organizationMembershipId)
  if (userId) {
    try {
      await revokeCollaborationForProjectMember(session.organizationId, projectId, userId)
    } catch (error) {
      console.warn('[members-service] collaboration cleanup after role removal failed:', error)
    }
    // Their last role on the project gone, the Steckbrief keeps them as a former member.
    const sameMember = assignments.filter(
      (other) => other.organizationMembershipId === assignment.organizationMembershipId
    )
    if (sameMember.every((other) => other.id === assignment.id)) {
      await recordMemberLeft(session, projectId, { userId, since: earliestMonth(sameMember) })
    }
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.role.removed',
    targetType: 'project',
    targetId: projectId,
    metadata: { organizationMembershipId: assignment.organizationMembershipId, roleSlug: 'none' },
    request,
  })
}

/** The month the earliest of these assignments was made: when the member joined. */
function earliestMonth(assignments: ReadonlyArray<{ createdAt: string }>): Month | null {
  const first = assignments.map((assignment) => assignment.createdAt).sort()[0]
  return dateToMonth(first)
}

/** Null when WorkOS cannot say; the callers' follow-ups are best-effort. */
async function userOfMembership(organizationMembershipId: string): Promise<string | null> {
  try {
    const membership = await getWorkOS().userManagement.getOrganizationMembership(organizationMembershipId)
    return membership?.userId ?? null
  } catch (error) {
    console.warn('[members-service] membership lookup failed:', error)
    return null
  }
}

async function keepDepartedMember(
  session: AuthorizedSession,
  projectId: string,
  organizationMembershipId: string,
  since: Month | null
): Promise<void> {
  const userId = await userOfMembership(organizationMembershipId)
  if (userId) await recordMemberLeft(session, projectId, { userId, since })
}
