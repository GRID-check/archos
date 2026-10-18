/**
 * What one answer's turn changed (ADR-0109): `GET` → `{ changes }`, each as it
 * stands now, with `canUndo` for the card's button. Changes on documents the
 * reader may not see are left out. Thin handler; the rules live in
 * `@/lib/changes/service`, the contract in `@/lib/changes/types`.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { listTurnChanges } from '@/lib/changes/service'
import type { TurnChangesResponse } from '@/lib/changes/types'

type Params = { id: string; messageId: string }

/** The answer id the backend derives is a uuid, and so is `origin_message_id`. */
const messageIdSchema = z.string().uuid()

export const GET = apiRoute<Params>(
  async ({ session, params }): Promise<TurnChangesResponse> => {
    const messageId = messageIdSchema.safeParse(params.messageId)
    if (!messageId.success) throw new BadRequestError('Invalid message id')
    return { changes: await listTurnChanges(session, params.id, messageId.data) }
  },
  {
    authz: {
      enforcedBy:
        "listTurnChanges (requireResourceAccess viewer on the conversation + each change's document through listAnnotations' read gate)",
    },
  }
)
