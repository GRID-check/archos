/**
 * Project summary generation API — generate and persist an AI profile summary.
 * Thin handler; the backend call and persistence live in
 * `@/lib/project-profile/profile-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { generateProjectSummary } from '@/lib/project-profile/profile-service'
import { generateSummaryRequestSchema } from '@/lib/project-profile/profile-wire'

export const POST = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    // Optional body: { locale } — the UI language the summary should be written
    // in. Tolerate an absent/invalid body (legacy callers sent none).
    const parsed = generateSummaryRequestSchema.safeParse(await request.json().catch(() => null))
    return generateProjectSummary(session, params.id, { locale: parsed.success ? parsed.data.locale : undefined })
  },
  { authz: { enforcedBy: 'generateProjectSummary (requireProjectAccess project:edit)' } }
)
