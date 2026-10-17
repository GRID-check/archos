/**
 * Who of a list of people could open one document now: the question asked
 * before a person is put on the hook for it (a document's assignee) and before
 * anybody is told about it in the inbox (a mark's thread, a new Fassung), or
 * mentioned in a mark. Its sibling {@link mayWriteDocument} asks who could
 * change it: an Anmerkung's Zuständige must, to answer and close the mark.
 *
 * The shelf decides, and it asks permissions, never role names. A document on
 * the Büroablage opens for every member of the organization. One in a project
 * opens for whoever holds `project:view` on it AND may read the folder it is
 * filed in (ADR-0087, ADR-0088): being in the project does not open a folder
 * restricted to other roles, so a person who passes the first check alone
 * would be responsible for, or told about, a document they cannot see.
 * Anything else (a chat attachment) opens for nobody here, and nobody writes it
 * here: it has no team to act on it.
 *
 * Only the organization is read, so a detached announcement with no session
 * (`./fassung-notify`) asks the same question a request does.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWhoMayReadFolder, filterUsersWhoMayWriteFolder } from '@/lib/authz/folder-access'
import { DOCUMENT_WRITE_PERMISSIONS } from '@/lib/authz/folder-access-rule'
import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import {
  PERMISSION_CHECKS_AT_ONCE,
  resolveSubjectMembership,
  userHoldsProjectPermission,
} from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { inPool } from '@/lib/utils/in-pool'

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
    // One cached read of the organization's directory, not a lookup per
    // person: a picker passes the whole directory in.
    const directory = await loadOrganizationDirectory(organizationId)
    return new Set(people.filter((userId) => directory.has(userId)))
  }
  if (doc.scope !== 'project' || !doc.projectId) return new Set()
  const projectId = doc.projectId
  const inProject = await inPool(people, PERMISSION_CHECKS_AT_ONCE, async (userId) =>
    (await userHoldsProjectPermission({ organizationId }, projectId, userId, 'project:view')) ? userId : null
  )
  return filterUsersWhoMayReadFolder(
    organizationId,
    projectId,
    doc.folderId ?? null,
    inProject.filter((userId): userId is string => userId !== null)
  )
}

/**
 * Which of `userIds` may write `doc` now: what `getAccessibleDocument(…,
 * 'write')` decides for a session, asked about other people. Answering an
 * Anmerkung and closing it are writes, so this is who may be made its
 * Zuständige: a person who could only read the document would be on the hook
 * for a mark they cannot answer.
 *
 * On the Büroablage, whoever holds `org:archiv:manage` (`canManageArchiv`). In
 * a project, whoever holds `project:documents:write` or the older umbrella
 * `project:edit` on it (`DOCUMENT_WRITE_PERMISSIONS`, the ceiling) AND may
 * write in the folder it is filed in (ADR-0088). Permissions, never role
 * names; fails closed per person.
 */
export async function mayWriteDocument(
  tenant: Pick<AuthorizedSession, 'organizationId'>,
  doc: Pick<Document, 'scope' | 'projectId' | 'folderId'>,
  userIds: readonly string[]
): Promise<Set<string>> {
  const people = [...new Set(userIds)]
  if (people.length === 0) return new Set()
  const { organizationId } = tenant
  if (doc.scope === 'archiv') {
    const curators = await inPool(people, PERMISSION_CHECKS_AT_ONCE, async (userId) => {
      const membership = await resolveSubjectMembership(organizationId, userId)
      if (!membership) return null
      return (await orgRoleHoldsPermission(membership.role, ORG_PERMISSIONS.archivManage, organizationId)) ? userId : null
    })
    return new Set(curators.filter((userId): userId is string => userId !== null))
  }
  if (doc.scope !== 'project' || !doc.projectId) return new Set()
  const projectId = doc.projectId
  const writers = await inPool(people, PERMISSION_CHECKS_AT_ONCE, async (userId) => {
    for (const permission of DOCUMENT_WRITE_PERMISSIONS) {
      if (await userHoldsProjectPermission({ organizationId }, projectId, userId, permission)) return userId
    }
    return null
  })
  return filterUsersWhoMayWriteFolder(
    organizationId,
    projectId,
    doc.folderId ?? null,
    writers.filter((userId): userId is string => userId !== null)
  )
}
