/**
 * One project's view of the office's sensitive-data list, and its changes to
 * the name terms (ADR-0086, amendment of 2026-10-20; ticket 26, step „Ablage").
 *
 * Read by every member who may upload into the project, because the browser
 * screens names with the project's policy before a byte is sent. Changed by
 * whoever manages the project (`project:manage`): the same people who review
 * the project's quarantine and may already release any held file in it one by
 * one, so setting a term aside for the project gives nobody a power they did
 * not hold. Audited with counts, never the terms.
 */

import 'server-only'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { can } from '@/lib/authz/decide'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { UploadScreeningPolicy } from './policy'
import {
  EMPTY_PROJECT_OVERRIDE,
  applyProjectOverride,
  effectiveOverride,
  type ProjectScreeningOverride,
} from './project-policy'
import { saveProjectScreeningOverride } from './project-repository'
import {
  forgetProjectScreeningOverride,
  getProjectScreeningOverride,
  getUploadScreeningPolicy,
  hasSavedUploadScreeningPolicy,
} from './service'

/** `GET /api/projects/{id}/upload-screening`. */
export interface ProjectUploadScreening {
  /** The policy uploads into this project are screened with. */
  policy: UploadScreeningPolicy
  /** The office's own list, for showing what the project changes. */
  office: UploadScreeningPolicy
  /** The office is still on Piloti's suggested list. */
  officeSuggested: boolean
  /** What this project changes, as it means something against the office's list. */
  override: ProjectScreeningOverride
  /** The reader may change the project's terms (`project:manage`, project not closed). */
  canManage: boolean
}

async function viewOf(session: AuthorizedSession, projectId: string, closed: boolean): Promise<ProjectUploadScreening> {
  const [office, stored, saved, manage] = await Promise.all([
    getUploadScreeningPolicy(session.organizationId),
    getProjectScreeningOverride(session.organizationId, projectId),
    hasSavedUploadScreeningPolicy(session.organizationId),
    closed ? Promise.resolve(false) : can(session, 'project:manage', { type: 'project', id: projectId }),
  ])
  const override = effectiveOverride(office, stored ?? EMPTY_PROJECT_OVERRIDE)
  return {
    policy: applyProjectOverride(office, override),
    office,
    officeSuggested: !saved,
    override,
    canManage: manage && office.enabled,
  }
}

/** The project's policy and what it changes. Any member who may read the project. */
export async function getProjectUploadScreening(
  session: AuthorizedSession,
  projectId: string
): Promise<ProjectUploadScreening> {
  const access = await requireProjectAccess(session, projectId, 'project:view')
  return viewOf(session, projectId, access.closed)
}

/**
 * Save what the project changes (already validated by the route's schema).
 * Kept only as far as it changes something against the office's list now; an
 * override that changes nothing removes the row.
 */
export async function saveProjectUploadScreening(
  session: AuthorizedSession,
  projectId: string,
  input: ProjectScreeningOverride,
  request: Request
): Promise<ProjectUploadScreening> {
  await requireProjectAccess(session, projectId, 'project:manage')
  // The office's list as it is now; unreadable is a failed save, never a save
  // measured against Piloti's suggestion.
  const office = await getUploadScreeningPolicy(session.organizationId)
  const override = effectiveOverride(office, input)
  await saveProjectScreeningOverride(session.organizationId, projectId, override, session.userId)
  await forgetProjectScreeningOverride(session.organizationId, projectId)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.upload_screening.updated',
    targetType: 'project',
    targetId: projectId,
    metadata: {
      addedNameTerms: override.addedNameTerms.length,
      removedNameTerms: override.removedNameTerms.length,
    },
    request,
  })
  return viewOf(session, projectId, false)
}
