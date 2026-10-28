/**
 * One reply in an Anmerkung's thread: PATCH rewords it, DELETE takes it back,
 * for the person who wrote it, while the mark is live and Piloti has not taken
 * it up. PATCH answers the Anmerkung with its whole thread. Thin handlers; the
 * rules live in `@/lib/annotations/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { roomPeerOf } from '@/lib/annotations/peer-header'
import { deleteOwnReply, editReply } from '@/lib/annotations/service'
import { updateReplyRequestSchema } from '@/lib/annotations/types'

type Params = { id: string; annotationId: string; replyId: string }

export const PATCH = apiRoute<Params>(
  async ({ session, request, params }) =>
    editReply(
      session,
      params.id,
      params.annotationId,
      params.replyId,
      await parseJsonBody(request, updateReplyRequestSchema),
      { kind: 'person', peerId: roomPeerOf(request) }
    ),
  {
    authz: {
      enforcedBy: 'editReply -> getAccessibleDocument (project:documents:write), own person replies only',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, request, params }) =>
    deleteOwnReply(session, params.id, params.annotationId, params.replyId, {
      kind: 'person',
      peerId: roomPeerOf(request),
    }),
  {
    authz: {
      enforcedBy: 'deleteOwnReply -> getAccessibleDocument (project:documents:write), own person replies only',
    },
  }
)
