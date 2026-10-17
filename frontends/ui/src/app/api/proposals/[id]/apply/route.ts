/**
 * Apply a proposed change (ADR-0105): `POST` → `{ proposal }` with its
 * `results`, 409 unless it is still `proposed`. The kind's applier runs in the
 * caller's session. The body is optional (`applyProposalRequestSchema`): an
 * empty one applies the proposal as proposed. Thin handler; the rules live in
 * `@/lib/proposals/service`.
 */

import { getLocale } from '@/i18n/server'
import { BadRequestError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { applyProposal } from '@/lib/proposals/service'
import { applyProposalRequestSchema, type ApplyProposalRequest } from '@/lib/proposals/types'

type Params = { id: string }

/** The optional body: none, or an empty one, is `{}`. */
async function applyBody(request: Request): Promise<ApplyProposalRequest> {
  const text = await request.text()
  if (!text.trim()) return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BadRequestError('Invalid JSON body')
  }
  const parsed = applyProposalRequestSchema.safeParse(raw)
  if (!parsed.success) throw new BadRequestError('Invalid request body', parsed.error.issues)
  return parsed.data
}

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await applyBody(request)
    return { proposal: await applyProposal(session, params.id, request, { ...body, locale: await getLocale() }) }
  },
  {
    authz: {
      enforcedBy:
        'applyProposal (read gate + requireProjectAccess with the kind’s right: project:documents:write for a file operation, project:memory:write for a note or a profile change, project:edit for all; then the applier’s own checks)',
    },
  }
)
