/**
 * Who a WorkOS user is, by name, when nobody is signed in to say so.
 *
 * A live session knows the person from AuthKit and the access token (the JWT
 * template's `organization_name` claim; docs/deployment/workos-provisioning.md).
 * Work done for someone who is not here, such as a scheduled run or a woken
 * thread, has no token, so its pinned session asks WorkOS the same question
 * through two lookups that already exist and are cached: the organization
 * directory and the organization's display name. Nothing here is a new
 * WorkOS call.
 */

import 'server-only'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

export interface Person {
  name: string | null
  email: string | null
  /** The office: the organization's display name. */
  organizationName: string | null
}

/**
 * The person `userId` is in `organizationId`, each field null when WorkOS
 * cannot say. Never throws: both lookups fail soft, and a run goes on without
 * the name rather than not at all.
 */
export async function resolvePerson(organizationId: string, userId: string): Promise<Person> {
  const [directory, organizationName] = await Promise.all([
    loadOrganizationDirectory(organizationId),
    getOrganizationDisplayName(organizationId),
  ])
  const person = directory.get(userId)
  // The directory falls back to the email, then 'Unknown', for a missing name:
  // a placeholder is not a name.
  const name = person && person.name !== person.email && person.name !== 'Unknown' ? person.name : null
  return { name, email: person?.email ?? null, organizationName }
}
