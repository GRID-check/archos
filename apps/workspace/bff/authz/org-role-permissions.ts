/**
 * What the roles a person holds in an organization grant, for the paths that
 * have that person's roles and no session to read claims from (ADR-0038): a
 * third party being invited or picked, a platform-org membership seen from a
 * tenant session, and the session Piloti acts in, which no browser minted.
 *
 * WorkOS answers it. `listOrganizationRoles` returns every role that applies to
 * the organization, the environment's and the office's own custom ones, each
 * with its permissions, in one call; this caches that map per organization for
 * a minute. The catalog is not consulted: the deploy applies it to WorkOS
 * (`grid-app-authz-catalog`), and a second, local answer is how a custom role
 * came to hold one set of permissions in the browser and another for Piloti.
 *
 * **Fails closed.** A lookup that fails, or a role WorkOS does not list, grants
 * nothing; the failure is not cached, so the next call asks again.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'
import { acceptedPermissionSlugs } from './permissions'

/**
 * How stale what a role holds may be. One minute, like the roles a person holds
 * (`./project-membership`): folder access is derived from both, so a longer
 * life here would keep a role that lost `org:projects:administer` writing
 * everywhere for as long as it lasted.
 */
export const ROLE_CACHE_TTL_MS = 60 * 1000

async function rolePermissionMap(organizationId: string): Promise<Record<string, string[]>> {
  return getCached(`authz:org-role-permissions:${organizationId}`, ROLE_CACHE_TTL_MS, async () => {
    const roles = await getWorkOS().authorization.listOrganizationRoles(organizationId)
    return Object.fromEntries(roles.data.map((role) => [role.slug, [...role.permissions]]))
  })
}

/** Every permission `roles` grant in the organization; empty when WorkOS could not say. */
export async function rolePermissions(organizationId: string, roles: readonly string[]): Promise<ReadonlySet<string>> {
  if (roles.length === 0) return new Set()
  try {
    const map = await rolePermissionMap(organizationId)
    return new Set(roles.flatMap((role) => map[role] ?? []))
  } catch (error) {
    console.warn(`[authz] role lookup failed for ${organizationId}:`, error)
    return new Set()
  }
}

/** Whether any of `roles` grants `permission` (or a name it was renamed from) in the organization. */
export async function rolesHoldPermission(
  organizationId: string,
  roles: readonly string[],
  permission: string
): Promise<boolean> {
  const held = await rolePermissions(organizationId, roles)
  return acceptedPermissionSlugs(permission).some((slug) => held.has(slug))
}
