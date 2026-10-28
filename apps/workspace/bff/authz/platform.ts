/**
 * Platform-tier authorization (ADR-0016).
 *
 * The platform tier is modeled as a dedicated WorkOS organization
 * ("GRID Platform", external id `grid-platform`) with an ORG-SCOPED role
 * `org-platform-owner` holding the `platform:*` permissions. WorkOS cannot
 * express a resource type above its Organization root (verified: creating a
 * parentless type and re-parenting Organization are both rejected), so the
 * org-scoped role IS the WorkOS-native way to model staff/platform access:
 * the role only exists inside the platform org, which makes it structurally
 * unassignable by tenant admins — exclusivity enforced by WorkOS itself.
 *
 * ## Membership is the precondition; the permission is the decision
 *
 * This module answers two different questions and they must not be confused:
 *
 *  - {@link isPlatformStaff} — may this session reach the platform tier AT ALL?
 *    That is membership of the platform organization (or break-glass), and it is
 *    what the nav flag and the route factory's precondition rest on.
 *  - {@link platformPermissions} / {@link requirePlatformPermission} — WHICH
 *    platform permission does it hold? Every platform surface asks this, because
 *    `org-platform-support` is defined as read-only and a single binary gate
 *    cannot express that. It used to be one binary, and Support consequently
 *    held write on every mutating platform route.
 *
 * A session holds platform permissions when:
 *  1. its ACTIVE org is the platform org — the permissions are its JWT claims
 *    (fast path, no I/O);
 *  2. it holds an active platform-org membership while browsing a TENANT org —
 *    the permissions are what that membership's roles hold, as WorkOS says, at
 *    most a minute old. Any platform-org role counts, not only `org-platform-owner`:
 *    Support was previously invisible on this path and got nothing at all; or
 *  3. break-glass bootstrap: their email is in PLATFORM_OWNER_EMAILS
 *     (documented in docs/deployment/workos-provisioning.md; intended for
 *     first-run in a fresh environment before provisioning). Break-glass grants
 *     every platform permission, and is always audited.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { recordAuditEvent } from '@/lib/audit/service'
import { rolePermissions } from './org-role-permissions'
import { ALL_PLATFORM_PERMISSION_SLUGS, PLATFORM_PERMISSIONS, type PlatformPermission } from './permissions'
import { resolveSubjectMembership } from './project-membership'
import type { UserSession } from '@/lib/auth/types'

export const PLATFORM_ORG_EXTERNAL_ID = process.env.PLATFORM_ORG_EXTERNAL_ID ?? 'grid-platform'
export const PLATFORM_OWNER_ROLE_SLUG = 'org-platform-owner'

const PLATFORM_ORG_CACHE_TTL_MS = 300_000
// A *missing* platform org is cached briefly so provisioning takes effect
// quickly (runbook first-run), while the found id can live longer.
const PLATFORM_ORG_NEGATIVE_TTL_MS = 30_000

let platformOrgCache: { fetchedAt: number; organizationId: string | null } | null = null
const BREAK_GLASS_AUDIT_INTERVAL_MS = 60 * 60 * 1000
const breakGlassAuditedAt = new Map<string, number>()

async function auditBreakGlassUse(session: UserSession): Promise<void> {
  // Keyed per actor AND active org: an owner hopping across tenant orgs
  // inside the window leaves one trail entry per org, not one total —
  // cross-org break-glass access is exactly what must stay visible.
  const throttleKey = `${session.userId}:${session.organizationId ?? 'none'}`
  const last = breakGlassAuditedAt.get(throttleKey)
  if (last && Date.now() - last < BREAK_GLASS_AUDIT_INTERVAL_MS) return
  breakGlassAuditedAt.set(throttleKey, Date.now())
  console.warn(
    `[Platform Authz] break-glass platform access granted to ${session.email} via PLATFORM_OWNER_EMAILS`
  )
  // WorkOS audit events are org-scoped — break-glass lands in the platform
  // org's trail. During true first-run (no platform org yet) only the log
  // line above exists; the runbook says to clear the allowlist afterwards.
  const platformOrgId = await getPlatformOrganizationId()
  if (platformOrgId) {
    await recordAuditEvent({
      organizationId: platformOrgId,
      actor: { userId: session.userId, email: session.email },
      action: 'platform.access.break_glass',
      targetType: 'platform',
      targetId: platformOrgId,
      metadata: { activeOrganizationId: session.organizationId },
    })
  }
}

/** Resolve (and cache) the platform organization's WorkOS id. */
export async function getPlatformOrganizationId(): Promise<string | null> {
  if (platformOrgCache) {
    const ttl = platformOrgCache.organizationId
      ? PLATFORM_ORG_CACHE_TTL_MS
      : PLATFORM_ORG_NEGATIVE_TTL_MS
    if (Date.now() - platformOrgCache.fetchedAt < ttl) {
      return platformOrgCache.organizationId
    }
  }
  try {
    const workos = getWorkOS()
    const org = await workos.organizations.getOrganizationByExternalId(PLATFORM_ORG_EXTERNAL_ID)
    platformOrgCache = { fetchedAt: Date.now(), organizationId: org.id }
  } catch {
    // Not provisioned (or WorkOS hiccup) — cache the miss briefly, fail closed.
    platformOrgCache = { fetchedAt: Date.now(), organizationId: null }
  }
  return platformOrgCache.organizationId
}

function bootstrapEmails(): string[] {
  return (process.env.PLATFORM_OWNER_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * The platform permissions a user's platform-org membership confers, or `null`
 * when they hold no active membership. Both halves come from the shared lookups
 * (`resolveSubjectMembership`, `rolePermissions`), each at most a minute old.
 * **Fails closed**: a lookup that fails is `null` or grants nothing.
 */
async function platformMembershipPermissions(
  userId: string,
  platformOrgId: string
): Promise<ReadonlySet<string> | null> {
  const membership = await resolveSubjectMembership(platformOrgId, userId)
  if (!membership) return null
  const held = await rolePermissions(platformOrgId, membership.roles)
  return new Set(ALL_PLATFORM_PERMISSION_SLUGS.filter((permission) => held.has(permission)))
}

/**
 * Every platform permission this session holds, or `null` when it is not
 * platform staff at all.
 *
 * `null` and the empty set mean different things and both are reachable: `null`
 * is "no platform membership", an empty set is "a member whose role holds
 * nothing", and only the first should read as *not staff*.
 */
export async function platformPermissions(
  session: UserSession | null
): Promise<ReadonlySet<string> | null> {
  if (!session) return null

  // Break-glass bootstrap for fresh environments — always audited, and total:
  // it exists to recover an environment whose provisioning has not run, so a
  // partial grant would leave the recovery half-usable.
  if (session.email && bootstrapEmails().includes(session.email.toLowerCase())) {
    await auditBreakGlassUse(session)
    return new Set(ALL_PLATFORM_PERMISSION_SLUGS)
  }

  const platformOrgId = await getPlatformOrganizationId()
  if (!platformOrgId) return null

  // Fast path: acting inside the platform org — the claims are the answer, with
  // the bounded catalog implication covering a session minted before a platform
  // permission was provisioned (the same rule `hasPermission` applies org-side).
  if (session.organizationId === platformOrgId) {
    const claimed = session.permissions.filter((permission) =>
      (ALL_PLATFORM_PERMISSION_SLUGS as readonly string[]).includes(permission)
    )
    return claimed.length === 0 ? null : new Set(claimed)
  }

  // Cross-org path: platform staff browsing a tenant org.
  return platformMembershipPermissions(session.userId, platformOrgId)
}

/**
 * True when this session may reach the platform tier at all.
 *
 * The PRECONDITION, not the decision — it says the caller is platform staff, not
 * that they may perform the action in front of them. Use it for the nav flag and
 * as the factory's first gate; use {@link requirePlatformPermission} to
 * authorize an actual surface.
 */
export async function isPlatformStaff(session: UserSession | null): Promise<boolean> {
  const permissions = await platformPermissions(session)
  if (permissions === null) return false
  // `platform:observability:view` opens Langfuse at the edge and nothing in
  // this app (ADR-0089): an analyst holding only it has no platform surface,
  // so showing them the area would show a page of 403s.
  return [...permissions].some((permission) => !EDGE_ONLY_PLATFORM_PERMISSIONS.has(permission))
}

/** Platform permissions checked at the edge only, never by a surface here. */
const EDGE_ONLY_PLATFORM_PERMISSIONS: ReadonlySet<string> = new Set([PLATFORM_PERMISSIONS.observabilityView])

/**
 * True when this session holds one specific platform permission.
 */
export async function hasPlatformPermission(
  session: UserSession | null,
  permission: PlatformPermission
): Promise<boolean> {
  const permissions = await platformPermissions(session)
  return permissions?.has(permission) ?? false
}

/** Typed denial — consumers map it to 403 explicitly (no string matching). */
export class PlatformAccessDeniedError extends Error {
  readonly status = 403
  constructor(message = 'Platform owner access required') {
    super(message)
    this.name = 'PlatformAccessDeniedError'
  }
}

/**
 * Throws PlatformAccessDeniedError unless the session holds `permission`.
 *
 * This is the gate every platform surface should use. The old
 * `requirePlatformPermission` asked only whether the caller was platform staff, which
 * meant the read-only `org-platform-support` role passed the gate on eleven
 * mutating routes.
 */
export async function requirePlatformPermission(
  session: UserSession | null,
  permission: PlatformPermission
): Promise<void> {
  if (!(await hasPlatformPermission(session, permission))) {
    throw new PlatformAccessDeniedError(`Platform permission required: ${permission}`)
  }
}

/** Test hook. */
export function _clearPlatformCaches(): void {
  platformOrgCache = null
  breakGlassAuditedAt.clear()
}
