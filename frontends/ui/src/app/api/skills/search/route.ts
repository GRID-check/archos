/**
 * The office's skills ranked by the words of a task: name, description and the
 * lines of each body that match. Thin adapter (ADR-0017); the ranking lives in
 * `@/lib/skills/service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { searchSkills } from '@/lib/skills/service'
import { skillSearchQuerySchema } from '@/lib/skills/types'

export const GET = apiRoute(
  async ({ session, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const { query, limit } = parseQuery(request, skillSearchQuerySchema)
    return searchSkills(session, query, limit)
  },
  {
    authz: {
      enforcedBy: 'searchSkills (org member: reading a procedure is use, not administration)',
    },
  }
)
