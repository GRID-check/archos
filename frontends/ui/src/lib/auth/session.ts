/**
 * Server-side session helpers built on WorkOS AuthKit v4.
 */

import { getTokenClaims, withAuth } from '@workos-inc/authkit-nextjs'
import { currentActingSession } from '@/lib/agent-api/acting-session'
import { lookupSubjectMembership, type SubjectMembership } from '@/lib/authz/project-membership'
import { clearTenantContext, enterTenantContext } from '@/lib/db/tenant-context'
import { SessionRequiredError } from '@/lib/api/errors'
import type { GridSession } from './types'

/**
 * The session's membership, id and roles, from the one membership lookup
 * (cached a minute). `null` when the person is not an active member: no id and
 * no roles, which every check reads as "no access". `undefined` when WorkOS
 * could not be asked: no id either, and the token's roles stand in.
 */
async function membershipOf(organizationId: string, userId: string): Promise<SubjectMembership | null | undefined> {
  try {
    return await lookupSubjectMembership(organizationId, userId)
  } catch (error) {
    console.warn(`[session] membership lookup failed for ${userId}:`, error)
    return undefined
  }
}

/**
 * Every role the membership holds (ADR-0087): the token's `roles` claim when
 * WorkOS's "multiple roles" setting puts one there, else the single `role`.
 * Strings only; anything else in the claim is dropped rather than trusted.
 */
export function sessionRoles(fromAuth: unknown, fromClaims: unknown, single: string | null): string[] {
  const listed = Array.isArray(fromAuth) ? fromAuth : Array.isArray(fromClaims) ? fromClaims : null
  const roles = (listed ?? []).filter((role): role is string => typeof role === 'string' && role.length > 0)
  if (roles.length === 0 && single) return [single]
  return [...new Set(roles)]
}

/**
 * Read the current Grid session from the WorkOS AuthKit session cookie.
 *
 * Uses `withAuth()` (and `getTokenClaims()` for raw JWT claims) from AuthKit v4.
 * Returns `null` when the user is not signed in.
 */
export async function getGridSession(): Promise<GridSession | null> {
  // A call dispatched by Piloti's MCP server (ADR-0122) runs the browser's
  // route handler as the person the endpoint already authenticated.
  const actingSession = currentActingSession()
  if (actingSession) {
    enterTenantContext(actingSession)
    return actingSession
  }

  const auth = await withAuth()

  if (!auth.user || !auth.accessToken) {
    // Clear rather than leave alone. Pages and layouts call this without a
    // route factory around them, so the slot may still hold a scope; returning
    // null while leaving it in place lets anything that queries afterwards read
    // as whoever was there before. Signed out means no tenant.
    clearTenantContext()
    return null
  }

  // Raw claims are available from the access token if we need to resolve
  // additional custom claims beyond what withAuth() already surfaces.
  const claims = await getTokenClaims(auth.accessToken)

  const name =
    auth.user.firstName && auth.user.lastName
      ? `${auth.user.firstName} ${auth.user.lastName}`
      : auth.user.firstName || auth.user.lastName || auth.user.name || null

  const organizationId = auth.organizationId ?? null

  const membership = organizationId ? await membershipOf(organizationId, auth.user.id) : undefined
  const tokenRole = auth.role ?? (typeof claims.role === 'string' ? claims.role : null)

  const session: GridSession = {
    userId: auth.user.id,
    email: auth.user.email,
    name,
    accessToken: auth.accessToken,
    organizationId,
    organizationMembershipId: membership?.organizationMembershipId ?? null,
    role: tokenRole,
    // The roles folder access is decided on (ADR-0088): WorkOS's membership,
    // at most a minute old, so a revoked role stops opening folders within a
    // minute; the token's claim only when WorkOS could not be asked.
    roles: membership === undefined ? sessionRoles(auth.roles, claims.roles, tokenRole) : (membership?.roles ?? []),
    permissions: auth.permissions ?? [],
    featureFlags: auth.featureFlags ?? null,
    profilePictureUrl: auth.user.profilePictureUrl ?? null,
    organizationName: typeof claims.organization_name === 'string' ? claims.organization_name : null,
  }

  // Publish the tenant to the database layer (ADR-0041). This is the one place
  // that knows who is asking on EVERY authenticated path — API routes reach it
  // through `requireAuthorizedSession`, pages and server actions through
  // `requireAuthorizedPageSession` — so it is also the one place that has to
  // say so. Repositories keep their signatures; row-level security gets its
  // organization without a single call site being able to forget to pass one.
  enterTenantContext(session)

  return session
}

/**
 * Require a signed-in Grid session.
 *
 * @throws {SessionRequiredError} when no WorkOS session is present.
 */
export async function requireGridSession(): Promise<GridSession> {
  const session = await getGridSession()

  if (!session) {
    throw new SessionRequiredError()
  }

  return session
}
