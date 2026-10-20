/**
 * One project's sensitive-data list (ADR-0086, amendment of 2026-10-20), through
 * `GET|PUT /api/projects/[id]/upload-screening`: the policy uploads into the
 * project are screened with, the office's list, and what the project changes
 * about its name terms.
 */

import { z } from 'zod'
import { uploadScreeningPolicySchema } from '@/lib/upload-screening/policy'
import type { ProjectScreeningOverride } from '@/lib/upload-screening/project-policy'
import { ApiRequestError } from './api-error'

const OverrideSchema = z.object({
  addedNameTerms: z.array(z.string()),
  removedNameTerms: z.array(z.string()),
})

const ProjectUploadScreeningSchema = z.object({
  policy: uploadScreeningPolicySchema,
  office: uploadScreeningPolicySchema,
  officeSuggested: z.boolean(),
  override: OverrideSchema,
  canManage: z.boolean(),
})

export type ProjectUploadScreeningState = z.infer<typeof ProjectUploadScreeningSchema>

const url = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/upload-screening`

async function failure(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return new ApiRequestError(typeof message === 'string' && message ? message : `${fallback}: ${response.status}`, response.status)
}

export async function getProjectUploadScreening(projectId: string): Promise<ProjectUploadScreeningState> {
  const response = await fetch(url(projectId))
  if (!response.ok) throw await failure(response, 'Failed to load the project screening')
  return ProjectUploadScreeningSchema.parse(await response.json())
}

export async function saveProjectUploadScreening(
  projectId: string,
  override: ProjectScreeningOverride
): Promise<ProjectUploadScreeningState> {
  const response = await fetch(url(projectId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(override),
  })
  if (!response.ok) throw await failure(response, 'Failed to save the project screening')
  return ProjectUploadScreeningSchema.parse(await response.json())
}
