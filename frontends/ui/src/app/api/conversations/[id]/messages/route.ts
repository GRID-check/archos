/**
 * Conversation messages API — list a conversation's history and append
 * messages (single object or batch array; both return an array). Thin
 * handlers; all logic lives in `@/lib/conversations/service`.
 *
 * The POST response carries the server's addressee ruling on each persisted
 * message (`addressees`, `createdRequests`) alongside the row, so the client can
 * decide whether to open an agent turn (ADR-0034). Extra fields only — the array
 * shape existing callers expect is unchanged.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { createMessagesSchema } from '@/lib/conversations/conversation-wire'
import { createConversationMessages, listConversationMessages } from '@/lib/conversations/service'
import {
  DEFAULT_MUTATION_LIMIT,
  enforceLimit,
  memberSubject,
} from '@/lib/limits'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => listConversationMessages(session, params.id),
  { authz: { enforcedBy: 'listConversationMessages (requireResourceAccess)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, createMessagesSchema)
    const inputs = Array.isArray(body) ? body : [body]
    // `apiRoute` already charged one unit before this handler ran. A batch does
    // N times the work of a single post, so charge the remainder: the budget
    // then meters messages written rather than requests sent, and a batch cannot
    // buy work that the same number of single posts would have been refused.
    if (inputs.length > 1) {
      await enforceLimit(DEFAULT_MUTATION_LIMIT, memberSubject(session), inputs.length - 1)
    }
    return createConversationMessages(session, params.id, inputs)
  },
  { status: 201, authz: { enforcedBy: 'createConversationMessages (requireResourceAccess)' } }
)
