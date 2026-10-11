/**
 * Who is on a project right now: the people holding a role on it in WorkOS,
 * named from the organization directory, each with the month they were added.
 * The Steckbrief lists them without anyone typing them in (ADR-0091).
 *
 * Only roles assigned on the project itself count. An organization admin
 * reaches every project through `org:projects:administer` without being on any
 * of them, so the record of who worked on a project does not name them.
 *
 * This module decides no access. Its caller has checked the reader may see the
 * project; the roster it returns is names and months, never an e-mail address.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { dateToMonth, type Month } from './month'
import { findProjectWorkosResourceId } from './repository'

export interface ProjectTeamMember {
  userId: string
  name: string
  /** The month their first role on the project was assigned. */
  since: Month | null
}

/**
 * The project's members, ordered by when they joined, or null when WorkOS
 * could not be asked. Null is "unknown", never "nobody": a caller shows what it
 * has stored and does not call anyone a former member on the strength of it.
 */
export async function loadProjectTeam(projectId: string, organizationId: string): Promise<ProjectTeamMember[] | null> {
  try {
    const resourceId = await findProjectWorkosResourceId(projectId, organizationId)
    if (!resourceId) return null
    const workos = getWorkOS()
    const [assignments, memberships, directory] = await Promise.all([
      workos.authorization.listRoleAssignmentsForResource({ resourceId }).then((page) => page.autoPagination()),
      workos.userManagement
        .listOrganizationMemberships({ organizationId, limit: 100 })
        .then((page) => page.autoPagination()),
      loadOrganizationDirectory(organizationId),
    ])
    const userOf = new Map(memberships.map((membership) => [membership.id, membership.userId]))
    // A membership may hold several assignments (direct and through a group);
    // the earliest says when they joined.
    const since = new Map<string, string>()
    for (const assignment of assignments) {
      const userId = userOf.get(assignment.organizationMembershipId)
      if (!userId) continue
      const earlier = since.get(userId)
      if (!earlier || assignment.createdAt < earlier) since.set(userId, assignment.createdAt)
    }
    return [...since]
      .map(([userId, createdAt]) => ({ userId, name: directory.get(userId)?.name ?? null, since: dateToMonth(createdAt) }))
      .filter((member): member is ProjectTeamMember => member.name !== null)
      .sort((a, b) => (a.since ?? '').localeCompare(b.since ?? '') || a.name.localeCompare(b.name))
  } catch (error) {
    console.warn(`[project-team] roster of ${projectId} could not be read:`, error)
    return null
  }
}
