/**
 * The roles a person holds in an organization, as WorkOS says NOW (ADR-0088).
 *
 * A folder's access list names roles, so the roles that decide it must follow
 * WorkOS within a minute: a role taken away in the People tab stops opening a
 * folder before the person's token is refreshed. The token's `roles` claim is
 * the fallback for a lookup that could not be made, never the first answer.
 *
 * One minute old at most (`lookupSubjectMembership`, the one membership lookup).
 * "Could not ask" is not cached, so the next request asks again.
 */

import 'server-only'
import { lookupSubjectMembership } from '@/lib/authz/project-membership'

/**
 * The person's roles in the organization: `[]` when they are not an active
 * member, `null` when WorkOS could not be asked (the caller decides its fallback).
 */
export async function resolveMembershipRoles(organizationId: string, userId: string): Promise<string[] | null> {
  try {
    return (await lookupSubjectMembership(organizationId, userId))?.roles ?? []
  } catch (error) {
    console.warn(`[membership-roles] lookup failed for ${userId}:`, error)
    return null
  }
}
