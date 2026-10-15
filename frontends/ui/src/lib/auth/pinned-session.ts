/**
 * A session for somebody who is not here.
 *
 * Unattended work — a scheduled task filing its report at 03:00 — has to act
 * as a person, because everything downstream reads a person: the permission
 * check, `documents.created_by`, the audit actor. The design that introduced
 * agent-authored documents refused the shortcut (a service token that files as
 * nobody) and named the alternative: "the requester's permission, resolved at
 * task creation and pinned on the row" (agent-authored-documents design,
 * decision 10). This is the resolution half of that.
 *
 * It is built from the STORED requester only — a WorkOS user id the task row
 * pinned when the person set the work up — and from what WorkOS says about
 * that person NOW: their membership, their role, the organization's flags. A
 * requester who left the organization resolves to nothing, and the caller
 * refuses rather than files. No access token: nothing on the filing path
 * forwards one, and a session that carried a fabricated one would be a
 * credential this module has no business minting.
 *
 * The person by name too (`resolvePerson`): a live session has the name from
 * AuthKit, and a pinned one that left it null sent every unattended turn to the
 * agent as nobody in particular.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { permissionsForOrgRole } from '@/lib/authz/permissions'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { resolvePerson } from './person'

export interface PinnedRequester {
  userId: string
  email: string | null
  organizationId: string
}

/**
 * The session the requester would have if they were signed in right now, or
 * `null` when they are no longer a member of the organization.
 *
 * Feature flags are resolved per organization (the JWT claim a live session
 * carries is per user+org, and the org-level answer is what the fleet-wide
 * kill switch means). Where nobody authenticates the gates ignore the claim, so
 * the empty set `enabledFlagsForOrganization` answers without a WorkOS key is
 * never read.
 *
 * EVERY flag the organization has, not the one the first caller needed. This
 * resolved only `agent-authored-documents`, and asked for it with the slug and
 * the organization swapped, so every pinned session carried
 * no flags at all. A scheduled report could then never file
 * (`isAgentAuthoredDocumentsEnabled` read the empty set), and the mail import
 * (ADR-0085), which files through the upload path's `image-upload` gate, would
 * have refused every picture.
 */
export async function resolvePinnedRequesterSession(
  requester: PinnedRequester,
): Promise<AuthorizedSession | null> {
  const membership = await resolveSubjectMembership(requester.organizationId, requester.userId)
  // No membership, or a membership without a role, is a person who holds
  // nothing here today; the caller refuses rather than guesses a role.
  if (!membership || !membership.role) return null

  const [featureFlags, person] = await Promise.all([
    enabledFlagsForOrganization(requester.organizationId),
    resolvePerson(requester.organizationId, requester.userId),
  ])

  return {
    userId: requester.userId,
    email: requester.email ?? person.email ?? '',
    name: person.name,
    organizationName: person.organizationName,
    accessToken: '',
    organizationId: requester.organizationId,
    organizationMembershipId: membership.organizationMembershipId,
    role: membership.role,
    permissions: [...permissionsForOrgRole(membership.role)],
    featureFlags,
  }
}
