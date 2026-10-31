/**
 * BIM geometry API — one geometry operation on one model (ADR-0149): element boxes, boxes per
 * group, what lies within a region or near an element, what is in a room, what touches an
 * element, clashes, and how boxes moved against another revision. Thin handler; access and the
 * call to the geometry service live in `@/lib/bim/geometry-service`.
 *
 * POST because the body is a typed operation; it is a read, rate limited like the query route.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BIM_QUERY_LIMIT } from '@/lib/limits'
import { geometryRequestSchema } from '@/lib/bim/geometry-wire'
import { geometryForAccessibleModel } from '@/lib/bim/geometry-service'

type Params = { modelId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const operation = await parseJsonBody(request, geometryRequestSchema)
    return geometryForAccessibleModel(session, params.modelId, operation)
  },
  {
    limits: { rule: BIM_QUERY_LIMIT },
    authz: {
      enforcedBy:
        'geometryForAccessibleModel -> getAccessibleModel (ifc-models flag + the document read gate: project:view, the conversation grant, or the office shelf), and again for a diff base model',
    },
  }
)
