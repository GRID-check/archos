/**
 * Conversation message detail API — record the user's answers to an answer's
 * interactive cards, and the answer's own provenance. Thin handler; all logic
 * lives in `@/lib/conversations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { updateMessageSchema } from '@/lib/conversations/conversation-wire'
import { updateMessageDetail } from '@/lib/conversations/service'

type Params = { id: string; messageId: string }

/** `messages.id` is a uuid column — a malformed id must 400, not blow up in SQL. */
const messageIdSchema = z.string().uuid()

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const messageId = messageIdSchema.safeParse(params.messageId)
    if (!messageId.success) throw new BadRequestError('Invalid message id')

    const body = await parseJsonBody(request, updateMessageSchema)
    return updateMessageDetail(session, params.id, messageId.data, {
      cardInteractions: body.cardInteractions,
      provenance: body.provenance,
      promptState: body.promptState,
      stages: body.stages,
    })
  },
  { authz: { enforcedBy: 'updateMessageDetail (requireResourceAccess)' } }
)
