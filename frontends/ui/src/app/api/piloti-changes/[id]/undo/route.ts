/**
 * Undo one change Piloti applied (ADR-0109): `POST` → `{ change }`, now undone.
 * 409 `{ error: 'moved-on' | 'already-undone', message }` when the object is no
 * longer as Piloti left it or somebody undid it first; the inverse runs through
 * the annotations service as the person clicking. Thin handler; the rules live
 * in `@/lib/changes/service`, the contract in `@/lib/changes/types`.
 */

import { z } from 'zod'
import { NotFoundError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { undoChange, UndoRefusedError } from '@/lib/changes/service'
import type { UndoChangeResponse } from '@/lib/changes/types'

type Params = { id: string }

const idSchema = z.string().uuid()

export const POST = apiRoute<Params>(
  async ({ session, params }): Promise<UndoChangeResponse | Response> => {
    const id = idSchema.safeParse(params.id)
    if (!id.success) throw new NotFoundError()
    try {
      return { change: await undoChange(session, id.data) }
    } catch (error) {
      // The contract's refusal names the code in `error`, which the client reads.
      if (!(error instanceof UndoRefusedError)) throw error
      return Response.json(
        { error: error.refusal, message: error.message, code: error.code, details: error.details },
        { status: error.status }
      )
    }
  },
  {
    authz: {
      enforcedBy:
        "undoChange (requireResourceAccess viewer on the turn's conversation + the document's read gate; the inverse through the annotations service's write checks)",
    },
  }
)
