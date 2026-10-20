/**
 * MSW handler for the office's upload-screening policy (ADR-0086).
 *
 * Every upload path reads the policy before it sends anything, and a policy
 * that cannot be read sends nothing: the browser no longer screens with
 * Piloti's suggestion in its place. A test that renders an upload surface
 * therefore needs an answer here, or every upload in it is refused. The
 * default is an office that kept Piloti's suggested list. A test that cares
 * about a specific policy, or about the policy being unreadable, overrides
 * this with `server.use(...)`.
 *
 * An upload into a project reads the project's policy instead
 * (`/api/projects/{id}/upload-screening`, ADR-0086 amendment of 2026-10-20);
 * by default a project that changed nothing, as {@link projectScreeningBody}.
 */

import { http, HttpResponse } from 'msw'
import { SUGGESTED_SCREENING_POLICY, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'

/** The project route's answer for a project on this office policy that changed nothing. */
export function projectScreeningBody(policy: UploadScreeningPolicy = SUGGESTED_SCREENING_POLICY) {
  return {
    policy,
    office: policy,
    officeSuggested: policy === SUGGESTED_SCREENING_POLICY,
    override: { addedNameTerms: [], removedNameTerms: [] },
    canManage: false,
  }
}

export const uploadScreeningHandlers = [
  http.get('/api/organization/upload-screening', () =>
    HttpResponse.json({ policy: SUGGESTED_SCREENING_POLICY, suggested: true, suggestion: SUGGESTED_SCREENING_POLICY })
  ),
  http.get('/api/projects/:projectId/upload-screening', () => HttpResponse.json(projectScreeningBody())),
]
