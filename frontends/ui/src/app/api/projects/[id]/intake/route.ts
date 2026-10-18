/**
 * A project's intake (ADR-0111): `GET` → `{ intake }`, the review as the
 * reader may see it; `POST { scope }` → `{ intake }`, start a reading now
 * (`all` forgets what was read; while one runs, the next is queued behind it).
 * Thin handler; the rules live in `@/lib/project-intake/service`, the contract
 * in `@/lib/project-intake/types`, the typed client in `@/lib/project-intake/client`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { getIntakeView, startIntakeRun } from '@/lib/project-intake/service'
import { startIntakeRequestSchema, type IntakeResponse } from '@/lib/project-intake/types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }): Promise<IntakeResponse> => ({ intake: await getIntakeView(session, params.id) }),
  { authz: { enforcedBy: 'getIntakeView (requireProjectAccess project:view)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }): Promise<IntakeResponse> => {
    const body = await parseJsonBody(request, startIntakeRequestSchema)
    return { intake: await startIntakeRun(session, params.id, body) }
  },
  {
    authz: {
      enforcedBy: 'startIntakeRun (requireProjectAccess project:memory:write or project:edit; a closed project is a 409)',
    },
  }
)
