/**
 * One of the office's skills by name, with its body. Addressed by name because
 * a platform skill has no id. Thin adapter (ADR-0017); logic in
 * `@/lib/skills/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { readSkill } from '@/lib/skills/service'

type Params = { name: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return readSkill(session, params.name)
  },
  {
    authz: {
      enforcedBy: 'readSkill (org member: reading a procedure is use, not administration)',
    },
  }
)
