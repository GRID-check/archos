import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { findProjectTenancy } from '@/lib/projects/repository'
import {
  isProjectClosed,
  keptWhenClosed,
  openToOrganizationWhenClosed,
  projectClosedError,
} from '@/lib/projects/project-status'
import { hasPermission, ORG_PERMISSIONS } from './permissions'
import { effectiveResourcePermissions } from './resource-check'

export type ProjectPermission =
  | 'project:view'
  | 'project:edit'
  | 'project:manage'
  | 'project:chat'
  | 'project:documents:write'
  | 'project:documents:generate'
  | 'project:memory:write'
  | 'project:members:manage'
  | 'project:skills:manage'

/**
 * The DERIVED capability ladder — what this caller can do in the project, not
 * which role slug WorkOS assigned them.
 *
 * Deliberately narrower than the catalog's set of assignable project roles
 * (`ProjectMemberRole` in `lib/projects/members-service.ts`). `project-contributor`
 * is a real, assignable role, but it maps onto the same rung as
 * `project-viewer` everywhere the ladder is consumed — both read, neither
 * writes — so the ladder does not tell them apart. Chat access is checked as
 * the `project:chat` permission where it matters, which is the honest place for
 * it; see {@link requireProjectAccess}.
 */
export type ProjectRole = 'project-viewer' | 'project-editor' | 'project-admin'

/** Holding any one of these makes a project member an editor. */
const PROJECT_WRITE_PERMISSIONS: readonly ProjectPermission[] = ['project:edit', 'project:documents:write', 'project:memory:write']


/** What {@link requireProjectAccess} grants: the derived role, and how the project's status shaped it. */
export interface ProjectAccess {
  role: ProjectRole
  /** The project is closed (ADR-0090): read-only, whatever the role. */
  closed: boolean
  /**
   * The caller reads the project only because it is closed: they hold no FGA
   * grant on it and are not an organization admin. Their folder clearance is a
   * member's with no role (`clearanceOf`), so no restricted folder opens to them.
   */
  readsBecauseClosed: boolean
}

/**
 * Authorize a session against a project and derive its effective role.
 *
 * What the caller holds on the project is one WorkOS call
 * (`effectiveResourcePermissions` in `./resource-check`, with its short-TTL
 * cache and timing). See that module for the caching tradeoff.
 *
 * Denials throw {@link NotFoundError} (message "Not found") so responses
 * never confirm the existence of projects the caller may not see.
 */
export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  /**
   * The permission to require, or an ANY-OF list — holding any ONE of them is
   * enough. Order carries no meaning; the derived role is read from the
   * permissions the caller actually holds, not from the list's first entry.
   *
   * The list form exists for the ADR-0038 split of the old `project:edit`
   * umbrella into `project:documents:write` / `project:memory:write`. The
   * built-in editor and admin roles hold both the narrow permission and the
   * umbrella, but a CUSTOM role provisioned before the split may hold only
   * `project:edit` — passing `['project:documents:write', 'project:edit']` keeps
   * that grant working while new roles can be given just the narrow one.
   */
  permission: ProjectPermission | readonly ProjectPermission[] = 'project:view',
  options: {
    includeDeleted?: boolean
    /**
     * Ask the permission as if the project were active. Only for the one write a
     * closed project allows, reopening it (`project:manage`); never to read.
     */
    evenWhenClosed?: boolean
  } = {}
): Promise<ProjectAccess> {
  const requested: readonly ProjectPermission[] = Array.isArray(permission)
    ? permission
    : [permission as ProjectPermission]
  // Verify the project belongs to the current org (and is not soft-deleted,
  // unless the caller explicitly needs deleted projects, e.g. restore).
  // This tenancy check runs for EVERYONE — the org-admin bypass below only
  // skips the per-project FGA checks. Bypassing it for admins let an org-A
  // admin act on an org-B project by id (routes query by id downstream).
  const project = await findProjectTenancy(projectId)

  if (
    !project ||
    project.organizationId !== session.organizationId ||
    (project.deletedAt && !options.includeDeleted)
  ) {
    throw new NotFoundError()
  }

  // A closed project is read-only (ADR-0090). Decided BEFORE the org-admin
  // bypass below, or an admin would keep writing into it. A request whose every
  // permission is a write is refused outright, with a reason the UI can name;
  // an any-of list keeps only what a closed project still allows.
  const closed = isProjectClosed(project)
  const readOnly = closed && !options.evenWhenClosed
  const accepted = readOnly ? keptWhenClosed(requested) : requested
  if (accepted.length === 0) throw projectClosedError()

  // The org-wide project bypass (but never the tenancy check above).
  //
  // Gated on the PERMISSION `org:projects:administer`, not on the role slug
  // `admin`. Keying it on the name was the single place the "permission-driven,
  // never role-name driven" contract broke: a custom role holding every `org:*`
  // permission reached no project at all, while any role that merely happened to
  // be named `admin` administered every project in the tenant while holding
  // nothing. The token's claim answers it (`hasPermission`).
  //
  // Surfaced as the named `org-admin-bypass` rule when routed through
  // `./decide`, so the bypass is visible in a decision rather than implicit.
  if (hasPermission(session, ORG_PERMISSIONS.projectsAdminister)) {
    return { role: 'project-admin', closed, readsBecauseClosed: false }
  }

  // Everything the caller holds on this project, in one WorkOS call: the
  // requested permissions gate access, `project:manage` and `project:edit` only
  // refine the derived role.
  const effective = await effectiveResourcePermissions({
    organizationMembershipId: session.organizationMembershipId,
    organizationId: session.organizationId,
    resourceExternalId: projectId,
    resourceTypeSlug: 'project',
  })

  // Any-of: holding the narrow permission OR the legacy umbrella is enough.
  if (!accepted.some((permission) => effective.has(permission))) {
    // Every member of the organization reads a closed project and may chat
    // about it (ADR-0090), as a viewer who clears no restricted folder.
    if (readOnly && openToOrganizationWhenClosed(accepted)) {
      return { role: 'project-viewer', closed, readsBecauseClosed: true }
    }
    throw new NotFoundError()
  }

  // The derived role reads what the caller holds, not what they asked for.
  const asMember = (role: ProjectRole): ProjectAccess => ({ role, closed, readsBecauseClosed: false })
  if (effective.has('project:manage')) return asMember('project-admin')

  // The editor rung is "holds a WRITE permission", not "holds `project:edit`".
  // After the ADR-0038 split the umbrella is one of three ways to write, and a
  // role built the way the catalog now recommends holds only the narrow ones —
  // reading such a caller as a viewer would make them a mere reader on every
  // shared thread in a project whose corpus they can change.
  if (PROJECT_WRITE_PERMISSIONS.some((permission) => effective.has(permission))) {
    return asMember('project-editor')
  }
  return asMember('project-viewer')
}
