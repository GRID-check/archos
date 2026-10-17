/**
 * Who of a list of people could open one document now: the question asked
 * before a person is put on the hook for it (an Anmerkung's Zuständige, a
 * document's assignee) and before anybody is told about it in the inbox (a
 * mark's thread, a new Fassung).
 *
 * The shelf decides, and it asks permissions, never role names. A document on
 * the Büroablage opens for every member of the organization. One in a project
 * opens for whoever holds `project:view` on it AND may read the folder it is
 * filed in (ADR-0087, ADR-0088): being in the project does not open a folder
 * restricted to other roles, so a person who passes the first check alone
 * would be responsible for, or told about, a document they cannot see.
 * Anything else (a chat attachment) opens for nobody here: it has no team to
 * act on it.
 *
 * Only the organization is read, so a detached announcement with no session
 * (`./fassung-notify`) asks the same question a request does.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'

/** Which of `userIds` may open `doc` now. Fails closed per person, as every check under it does. */
export async function mayOpenDocument(
  tenant: Pick<AuthorizedSession, 'organizationId'>,
  doc: Pick<Document, 'scope' | 'projectId' | 'folderId'>,
  userIds: readonly string[]
): Promise<Set<string>> {
  const people = [...new Set(userIds)]
  if (people.length === 0) return new Set()
  const { organizationId } = tenant
  if (doc.scope === 'archiv') {
    const members = await Promise.all(
      people.map(async (userId) => ((await resolveSubjectMembership(organizationId, userId)) ? userId : null))
    )
    return new Set(members.filter((userId): userId is string => userId !== null))
  }
  if (doc.scope !== 'project' || !doc.projectId) return new Set()
  const projectId = doc.projectId
  const inProject = await Promise.all(
    people.map(async (userId) =>
      (await userHoldsProjectPermission({ organizationId }, projectId, userId, 'project:view')) ? userId : null
    )
  )
  return filterUsersWhoMayReadFolder(
    organizationId,
    projectId,
    doc.folderId ?? null,
    inProject.filter((userId): userId is string => userId !== null)
  )
}
