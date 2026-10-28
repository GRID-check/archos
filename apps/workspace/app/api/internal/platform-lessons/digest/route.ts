/**
 * Internal platform-lessons pull — the channel the Python backend resolves the
 * injected lesson digest through (`aiq_agent.common.platform_lessons`,
 * TTL-cached and fail-open there): `{ digest, lessonIds }`, the ids being the
 * lessons the digest holds, which the agent records on the trace. Token-guarded like
 * `/api/internal/retrieval-settings`; the payload is global, never org-scoped —
 * a lesson is anonymized fleet knowledge and identical for every tenant.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { buildPlatformLessonsInjection } from '@/lib/platform-lessons/service'

export const GET = internalApiRoute(
  'platform-lessons-digest',
  async () => {
    return await buildPlatformLessonsInjection()
  },
  {
    tenancy: {
      crossTenant:
        'platform lessons are anonymized fleet-wide knowledge, identical for every tenant',
    },
  }
)
