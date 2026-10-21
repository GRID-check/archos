/**
 * Human verdicts on the OIB rule catalogue.
 *
 * The catalogue settles what the model's published values can settle; the rest
 * an architect settles by reading a plan or asking a Brandschutzplaner. This is
 * where that judgement is recorded, against the revision they looked at.
 *
 * The confirming identity is taken from the SESSION, never from the body — a
 * signature a caller could address to somebody else is not a signature.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { confirmCheckSchema, withdrawCheckSchema } from '@/lib/bim/checks-wire'
import {
  confirmAccessibleCheck,
  listAccessibleCheckConfirmations,
  withdrawAccessibleCheck,
} from '@/lib/bim/model-service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    confirmations: await listAccessibleCheckConfirmations(session, params.id),
  }),
  {
    authz: {
      enforcedBy: 'listAccessibleCheckConfirmations (ifc-models flag + project:view)',
    },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, confirmCheckSchema)
    await confirmAccessibleCheck(session, params.id, {
      ruleId: body.ruleId,
      modelId: body.modelId,
      note: body.note ?? null,
    })
    return { ok: true }
  },
  {
    authz: {
      enforcedBy: 'confirmAccessibleCheck (ifc-models flag + project:edit + model tenancy)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, withdrawCheckSchema)
    await withdrawAccessibleCheck(session, params.id, body.ruleId, body.modelId)
    return { ok: true }
  },
  {
    authz: {
      enforcedBy:
        'withdrawAccessibleCheck (ifc-models flag + project:edit + model tenancy via getAccessibleModel)',
    },
  }
)
