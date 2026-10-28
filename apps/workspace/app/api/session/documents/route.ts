/**
 * Session documents API — list the files attached to one conversation.
 * Thin handler; all logic lives in `@/lib/session-documents/service`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listSessionDocuments } from '@/lib/session-documents/service'
import { listSessionDocumentsQuerySchema } from '@/lib/session-documents/session-documents-wire'

export const GET = apiRoute(
  async ({ session, request }) => {
    const { conversationId } = parseQuery(request, listSessionDocumentsQuerySchema)
    return listSessionDocuments(session, conversationId)
  },
  { authz: { enforcedBy: 'listSessionDocuments (requireResourceAccess conversation:viewer)' } },
)
