/**
 * Who of a list of people could open one document now: the question asked
 * before a person is put on the hook for it (an Anmerkung's Zuständige, a
 * document's assignee) and before anybody is told about it in the inbox.
 *
 * The shelf decides. A document on the Büroablage opens for every member of
 * the organization. One in a project opens for whoever may view the project
 * AND may read the folder it is filed in (ADR-0087, ADR-0088): being in the
 * project does not open a folder restricted to other roles, so a person who
 * passes the first check alone would be responsible for, or told about, a
 * document they cannot see. Anything else (a chat attachment) opens for nobody
 * here: it has no team to act on it.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'

/** Which of `userIds` may open `doc` now. Fails closed per person, as both checks do. */
export async function mayOpenDocument(
  session: AuthorizedSession,
  doc: Pick<Document, 'scope' | 'projectId' | 'folderId'>,
  userIds: readonly string[]
): Promise<Set<string>> {
  const people = [...new Set(userIds)]
  if (people.length === 0) return new Set()
  if (doc.scope === 'archiv') {
    const directory = await loadOrganizationDirectory(session.organizationId)
    return new Set(people.filter((userId) => directory.has(userId)))
  }
  if (doc.scope !== 'project' || !doc.projectId) return new Set()
  const projectId = doc.projectId
  const inProject = await Promise.all(
    people.map(async (userId) => ((await canUserAccessProject(session, projectId, userId)) ? userId : null))
  )
  return filterUsersWhoMayReadFolder(
    session.organizationId,
    projectId,
    doc.folderId ?? null,
    inProject.filter((userId): userId is string => userId !== null)
  )
}
