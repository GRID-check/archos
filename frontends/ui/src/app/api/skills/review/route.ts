/**
 * Skill review — ask the backend reviewer what is wrong with a skill draft.
 *
 * Thin adapter (ADR-0017); the backend call and its fail-open contract live in
 * `@/lib/skills/review`. Always resolves to 200 with `{ findings, error? }`:
 * the editor treats a null `findings` as "no review this time" and never blocks
 * a save on it.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { reviewSkill } from '@/lib/skills/review'
import { reviewSkillSchema } from '@/lib/skills/types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, reviewSkillSchema)
    return reviewSkill(session, input)
  },
  {
    authz: {
      enforcedBy: 'reviewSkill (org member — reviewing a draft is not a privileged action)',
    },
  }
)
