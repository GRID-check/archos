import 'server-only'
/**
 * Whether one member of the organization may review a held document's
 * quarantine (ADR-0086): an organization admin, a project admin the document's
 * folder is not hidden from (ADR-0087), or for the Büroablage its curators.
 * The rule `mayReviewQuarantine` applies to a session, asked about a person
 * there is no session for: the reviewers told about a quarantine
 * (`quarantineReviewersOf`) and who may open a held document
 * (`mayOpenDocument`) read this one definition.
 */

import { isFolderVisibleToMember } from '@/lib/authz/folder-access'
import { rolesHoldPermission } from '@/lib/authz/org-role-permissions'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema/documents'

export async function isQuarantineReviewer(
  organizationId: string,
  document: Pick<Document, 'scope' | 'projectId' | 'folderId'>,
  userId: string
): Promise<boolean> {
  const membership = await resolveSubjectMembership(organizationId, userId)
  if (!membership) return false
  if (await rolesHoldPermission(organizationId, membership.roles, ORG_PERMISSIONS.projectsAdminister)) return true
  if (document.scope === 'office_shelf') {
    return rolesHoldPermission(organizationId, membership.roles, ORG_PERMISSIONS.officeShelfManage)
  }
  if (document.scope !== 'project' || !document.projectId) return false
  const manages = await userHoldsProjectPermission({ organizationId }, document.projectId, userId, 'project:manage')
  if (!manages) return false
  return isFolderVisibleToMember(organizationId, document.projectId, document.folderId, userId)
}
