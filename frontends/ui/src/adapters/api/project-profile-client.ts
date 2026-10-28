/**
 * Project profile API client
 *
 * Typed fetch client for the one write the closing debrief makes to a project's
 * profile: accepting a fact the closing extraction suggested
 * (`POST /api/projects/[id]/profile/patches`). The patch is a JSON-patch document
 * (RFC 6902) of the form the profile route applies; the primitive value is the
 * profile's own type (`lib/project-profile/types.ts`).
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status.
 */

import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import { ApiRequestError } from './api-error'

/** Add one fact to the profile, at `/facts/{key}`. */
export const applyProjectProfileFact = async (
  projectId: string,
  key: string,
  value: ProjectPrimitiveValue,
): Promise<void> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/profile/patches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: [{ op: 'add', path: `/facts/${key}`, value }] }),
  })
  if (!response.ok) throw new ApiRequestError(`Failed to apply the profile fact: ${response.status}`, response.status)
}
