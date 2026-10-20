/**
 * One project's sensitive-data list (ADR-0086, amendment of 2026-10-20).
 *
 * GET — any member who may read the project: the browser screens names with
 *       the project's policy before an upload into it, so every uploader reads
 *       it. Answers the policy in force, the office's list, and what the
 *       project changes about its name terms.
 * PUT — `project:manage`: `{ addedNameTerms, removedNameTerms }`, the whole
 *       override. Content terms and detectors stay the office's. Audited with
 *       counts.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { projectScreeningOverrideSchema } from '@/lib/upload-screening/project-policy'
import { getProjectUploadScreening, saveProjectUploadScreening } from '@/lib/upload-screening/project-service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getProjectUploadScreening(session, params.id),
  { authz: { enforcedBy: 'getProjectUploadScreening -> requireProjectAccess (project:view)' } }
)

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const override = await parseJsonBody(request, projectScreeningOverrideSchema)
    return saveProjectUploadScreening(session, params.id, override, request)
  },
  { authz: { enforcedBy: 'saveProjectUploadScreening -> requireProjectAccess (project:manage)' } }
)
