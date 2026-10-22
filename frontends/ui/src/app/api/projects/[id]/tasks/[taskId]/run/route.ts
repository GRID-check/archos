/**
 * Manual "Run now" — fires a task immediately via the shared `fireJob`
 * path, and answers `{ run }`, the run's view. 409 when the task is disabled; a backend
 * admission cap (429) surfaces as a friendly `skipped` run.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { runJobNow } from '@/lib/jobs/service'

type Params = { id: string; taskId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return runJobNow(session, params.id, params.taskId)
  },
  {
    authz: {
      enforcedBy: 'runJobNow (requireProjectAccess project:skills:manage)',
    },
  }
)
