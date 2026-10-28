/**
 * "Can *that other person* reach this project?" — the container precondition
 * behind every invitation (spec SH-5, SH-19).
 *
 * Distinct from `requireProjectAccess`, which answers the question for the
 * CALLER using their own session. Here the subject is a third party: we are
 * deciding whether they may be invited to a resource, and whether they may
 * appear in a mention picker. There is no session to read, so the membership and
 * the fine-grained check are resolved explicitly.
 *
 * The two must agree, or sharing would either offer invitations that resolve to
 * nothing or refuse ones that would have worked. In particular the **org-wide
 * project bypass is mirrored deliberately**: `requireProjectAccess` grants
 * anyone holding `org:projects:administer` every project in their organization,
 * so such a subject is reachable here too — resolved through
 * `./org-role-permissions`, which asks WorkOS what the role holds instead of
 * matching its name.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getWorkOS } from '@/lib/workos/client'
import { rolesHoldPermission } from './org-role-permissions'
import { ORG_PERMISSIONS, type ProjectPermission } from './permissions'
import { findProjectTenancy } from '@/lib/projects/repository'
import { CLOSED_PROJECT_KEEPS, CLOSED_PROJECT_OPEN_TO_ORGANIZATION, isProjectClosed } from '@/lib/projects/project-status'
import { inPool } from '@/lib/utils/in-pool'

/**
 * How stale a membership and its roles may be behind an access decision. One
 * minute everywhere: a revoked role stops opening folders, and a person removed
 * from the office stops reaching it through an agent's token, within a minute.
 */
export const MEMBERSHIP_TTL_MS = 60 * 1000
const MEMBERSHIP_NEGATIVE_TTL_MS = 30 * 1000

export interface SubjectMembership {
  organizationMembershipId: string
  /** Every role slug the membership holds (several with WorkOS's "multiple roles"). */
  roles: string[]
  /** The first of {@link roles}, for the readers that know one role. */
  role: string | null
}

/** Every role slug the membership holds, else its one role. */
export function rolesOfMembership(membership: {
  role?: { slug?: string | null } | null
  roles?: ReadonlyArray<{ slug?: string | null }> | null
}): string[] {
  const listed = (membership.roles ?? []).map((role) => role.slug).filter((slug): slug is string => Boolean(slug))
  if (listed.length > 0) return [...new Set(listed)]
  return membership.role?.slug ? [membership.role.slug] : []
}

/**
 * A user's ACTIVE membership in an organization, with its roles, or `null` when
 * WorkOS ANSWERED that there is none. A lookup that could not be answered throws.
 *
 * The one membership lookup: the session's membership id and roles, a third
 * party's, the acting session's and the platform tier's all come from here,
 * so they cannot disagree about who is in the organization or what they hold.
 * "Not a member" is cached for the short negative TTL; a thrown lookup is not
 * cached at all, so the next request asks again.
 *
 * For a caller whose response to "not a member" cannot be undone (the push job
 * removes the person's devices): a WorkOS hiccup must not read as having left.
 * Callers that only need a fail-closed yes/no take {@link resolveSubjectMembership}.
 */
export async function lookupSubjectMembership(organizationId: string, userId: string): Promise<SubjectMembership | null> {
  return getCached(
    `org-membership:${organizationId}:${userId}`,
    MEMBERSHIP_TTL_MS,
    async () => {
      const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
        userId,
        organizationId,
        statuses: ['active'],
        limit: 1,
      })
      const membership = memberships.data[0]
      if (!membership) return null
      const roles = rolesOfMembership(membership)
      return { organizationMembershipId: membership.id, roles, role: roles[0] ?? null } satisfies SubjectMembership
    },
    { negativeTtlMs: MEMBERSHIP_NEGATIVE_TTL_MS }
  )
}

/**
 * A user's membership in an organization, with its roles; `null` when there is
 * none OR when the lookup failed. Fail closed, for the sharing decisions and
 * pickers, where "could not ask" must deny.
 *
 * The failure is caught outside `getCached`, so it is never stored. Caught
 * inside the loader, a single failed lookup was stored as "not a member", and
 * the colleague vanished from every picker for the negative TTL.
 */
export async function resolveSubjectMembership(organizationId: string, userId: string): Promise<SubjectMembership | null> {
  try {
    return await lookupSubjectMembership(organizationId, userId)
  } catch (error) {
    console.warn(`[project-membership] lookup failed for ${userId}:`, error)
    return null
  }
}

/**
 * Is `targetUserId` a member of the caller's organization at all?
 *
 * The precondition UNDERNEATH the container one. A resource with no container has
 * no project to gate on, but "no container" is not "no precondition": a grant may
 * still only name somebody inside the tenant. Without this, a grant row could be
 * written for an arbitrary — even foreign — user id, and the notification fan-out
 * would then publish to that foreign user's event channel.
 *
 * **Fails closed**, and deliberately built on the same cached membership lookup
 * `canUserAccessProject` starts from, so the two can never disagree about who
 * exists in the organization.
 */
export async function isUserInOrganization(
  session: AuthorizedSession,
  targetUserId: string
): Promise<boolean> {
  return (await resolveSubjectMembership(session.organizationId, targetUserId)) !== null
}

/**
 * Whether `targetUserId` can reach `projectId` in the caller's organization.
 *
 * **Fails closed**: an unknown user, a user outside the organization, or a failed
 * check all return `false`. A sharing decision must never default to "yes"
 * because a lookup broke.
 */
export async function canUserAccessProject(
  session: AuthorizedSession,
  projectId: string,
  targetUserId: string
): Promise<boolean> {
  return userHoldsProjectPermission(session, projectId, targetUserId, 'project:view')
}

/**
 * Whether `targetUserId` holds one specific project permission.
 *
 * The general form of {@link canUserAccessProject}, which is this asked about
 * `project:view`. Same fail-closed posture, and the same reason the org-wide
 * bypass is checked first: it is a PERMISSION, not the role slug `admin`.
 */
export async function userHoldsProjectPermission(
  /** Only the organization is read, so a sweep with no session can ask too. */
  session: Pick<AuthorizedSession, 'organizationId'>,
  projectId: string,
  targetUserId: string,
  permission: ProjectPermission
): Promise<boolean> {
  const membership = await resolveSubjectMembership(session.organizationId, targetUserId)
  if (!membership) return false

  // A closed project (ADR-0090), mirrored from requireProjectAccess: a write is
  // nobody's, and reading and chatting are every member's.
  const project = await findProjectTenancy(projectId)
  if (!project || project.organizationId !== session.organizationId || project.deletedAt) return false
  if (isProjectClosed(project)) {
    if (!CLOSED_PROJECT_KEEPS.has(permission)) return false
    if (CLOSED_PROJECT_OPEN_TO_ORGANIZATION.has(permission)) return true
  }

  // Mirror requireProjectAccess exactly: the org-wide project bypass is a
  // PERMISSION, not the role slug `admin`. The subject has no session here, so
  // their role's permission list is resolved from WorkOS (cached, catalog
  // fallback) rather than guessed from its name — otherwise a custom org role
  // holding `org:projects:administer` would reach every project while this
  // refused to invite them to any of them.
  if (await rolesHoldPermission(session.organizationId, membership.roles, ORG_PERMISSIONS.projectsAdminister)) {
    return true
  }

  try {
    const result = await getWorkOS().authorization.check({
      organizationMembershipId: membership.organizationMembershipId,
      permissionSlug: permission,
      resourceExternalId: projectId,
      resourceTypeSlug: 'project',
    })
    return result.authorized
  } catch (error) {
    console.warn(
      `[project-membership] FGA check failed for ${targetUserId} on ${projectId}:`,
      error
    )
    return false
  }
}

/**
 * Filter a set of candidate users down to those who can reach the project.
 *
 * Used by the mention picker and the invite picker, which must offer ONLY people
 * who satisfy the precondition (spec SH-19) — otherwise the UI invites someone
 * and the invitation is then refused, which reads as a bug.
 *
 * Checks run in parallel; each one independently fails closed.
 */
export async function filterUsersWithProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  candidateUserIds: readonly string[]
): Promise<Set<string>> {
  return filterUsersWithProjectPermission(session, projectId, candidateUserIds, 'project:view')
}

/**
 * How many people's permissions are asked of WorkOS at once. A list of
 * candidates can be a whole organization's directory; all at once is a burst
 * WorkOS throttles, and a throttled check fails closed, so eligible people
 * would silently go missing from a picker or a notice.
 */
export const PERMISSION_CHECKS_AT_ONCE = 8

/**
 * The same filter, for a permission that is not `project:view`.
 *
 * The reviewer picker needs `project:edit`: being able to OPEN a project does
 * not make somebody able to release a Brandschutzkonzept, and a picker that
 * offered them would open a round the approve transition then refuses. Same
 * fail-closed posture, same per-user independence.
 */
export async function filterUsersWithProjectPermission(
  session: AuthorizedSession,
  projectId: string,
  candidateUserIds: readonly string[],
  permission: ProjectPermission
): Promise<Set<string>> {
  const results = await inPool(candidateUserIds, PERMISSION_CHECKS_AT_ONCE, async (userId) => ({
    userId,
    allowed: await userHoldsProjectPermission(session, projectId, userId, permission),
  }))
  return new Set(results.filter((result) => result.allowed).map((result) => result.userId))
}
