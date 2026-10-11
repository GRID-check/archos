/**
 * Grid session types produced from the WorkOS AuthKit v4 session.
 *
 * All server-side code should consume these types instead of the raw
 * `@workos-inc/authkit-nextjs` types.
 */

export interface GridSession {
  /** WorkOS user id (JWT `sub` claim) */
  userId: string

  /** User email address */
  email: string

  /** Full display name, or null when not available */
  name: string | null

  /** Raw WorkOS access token to forward to the AI-Q backend */
  accessToken: string

  /** Active WorkOS organization id, or null when none is selected */
  organizationId: string | null

  /** Active WorkOS organization membership id, or null when not resolved */
  organizationMembershipId: string | null

  /** WorkOS role slug within the active organization, or null */
  role: string | null

  /**
   * Every role slug the membership holds in the active organization: the
   * token's `roles` claim when WorkOS's multiple-roles setting is on, else
   * `[role]`. Restricted folders name roles and are cleared by any one of
   * them (ADR-0087). Optional so a session built before this field — a pinned
   * requester, a test fixture — reads as `[role]`; use `rolesOf(session)`.
   */
  roles?: string[]

  /** WorkOS permissions within the active organization */
  permissions: string[]

  /**
   * The feature flags on for this user+org context (ADR-0102): the entitlements
   * the WorkOS JWT `feature_flags` claim carries, plus the rollouts PostHog has
   * not switched off for the organization (`sessionFeatureFlags` in
   * `lib/workos/feature-flags.ts`). A token without the claim contributes no
   * entitlements and changes no rollout. `null` only on a session built by hand
   * for a caller nobody is signed in as, for which every gate is off.
   */
  featureFlags: string[] | null

  /** WorkOS profile picture URL, or null when none is set. */
  profilePictureUrl?: string | null
}

/**
 * Grid session that is guaranteed to have an active WorkOS organization.
 *
 * Use this type for routes and API handlers that require tenant-scoped
 * authorization.
 */
export interface AuthorizedSession extends GridSession {
  organizationId: string
  organizationMembershipId: string
  role: string
  permissions: string[]
}

/** The roles a session holds, with the single `role` standing in for an absent list. */
export function rolesOf(session: Pick<GridSession, 'role' | 'roles'>): string[] {
  if (session.roles && session.roles.length > 0) return session.roles
  return session.role ? [session.role] : []
}
