/**
 * Decide on a project's intake (ADR-0111): `POST { decisions }` →
 * `{ results, intake }`, one result per decision in order and the review after
 * them. Confirm, dismiss, answer, or mark a key unknown; every write goes
 * through the profile's one door. Thin handler; the rules live in
 * `@/lib/project-intake/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { applyIntakeDecisions } from '@/lib/project-intake/service'
import { intakeDecisionsRequestSchema, type IntakeDecisionsResponse } from '@/lib/project-intake/types'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }): Promise<IntakeDecisionsResponse> => {
    const { decisions } = await parseJsonBody(request, intakeDecisionsRequestSchema)
    return applyIntakeDecisions(session, params.id, decisions)
  },
  {
    authz: {
      enforcedBy:
        'applyIntakeDecisions (requireProjectAccess project:memory:write or project:edit, then patchProjectProfile’s own gate)',
    },
  }
)
