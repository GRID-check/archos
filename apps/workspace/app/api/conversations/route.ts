/**
 * Conversations API — list and create conversations for the current
 * organization. Thin handlers; all logic lives in
 * `@/lib/conversations/service`.
 *
 * The list is **visibility-aware** (spec SH-4): it returns what the caller may
 * actually see, not every conversation in the organization. A new conversation is
 * created `private` and shared deliberately (spec MG-2).
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { createConversationSchema, listConversationsQuerySchema } from '@/lib/conversations/conversation-wire'
import { createConversation, listConversations } from '@/lib/conversations/service'

export const GET = apiRoute(
  async ({ session, request }) =>
    listConversations(session, parseQuery(request, listConversationsQuerySchema)),
  {
    authz: {
      enforcedBy: 'listConversations (requireProjectAccess project:view + resource access)',
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createConversationSchema)
    return createConversation(session, input)
  },
  { status: 201, authz: { enforcedBy: 'createConversation (requireProjectAccess project:view)' } }
)
