/**
 * Free-text intake consistency-check API (FB-13) — ask the backend LLM whether
 * the wizard's free-text answers contradict the structured answers (passed as
 * read-only context) before the profile is saved. Structured answers are
 * checked deterministically on the client, not here. Thin handler; the backend
 * call lives in `@/lib/project-profile/profile-service`.
 *
 * Best-effort by design: the service never throws, so this route always returns
 * 200 with `{ findings, error? }`. The wizard treats null/errored findings as
 * "proceed with the save" — a check outage must not block saving.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { checkProjectConsistency } from '@/lib/project-profile/profile-service'
import { consistencyCheckSchema } from '@/lib/project-profile/profile-wire'

export const POST = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, consistencyCheckSchema)
    return checkProjectConsistency(session, params.id, input)
  },
  { authz: { enforcedBy: 'checkProjectConsistency (requireProjectAccess project:edit)' } }
)
