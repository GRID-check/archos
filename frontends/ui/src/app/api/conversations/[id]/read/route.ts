/**
 * Conversation read-state API — move the caller's read high-water mark
 * (spec CC-18) and, as a consequence, clear the thread's ambient inbox items
 * (spec IB-9). Thin handler; all logic lives in `@/lib/conversations/service`.
 *
 * Read state is per person and server-side on purpose: with two people in a
 * thread, "unread" stopped being a property of one browser.
 *
 * POST with `{}` to mark "read as of now"; supply `lastReadMessageId` to anchor
 * the unread separator at an exact message (CC-19).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { markReadSchema } from '@/lib/conversations/conversation-wire'
import { markConversationRead } from '@/lib/conversations/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, markReadSchema)
    return markConversationRead(session, params.id, input)
  },
  { authz: { enforcedBy: 'markConversationRead (requireResourceAccess)' } }
)
