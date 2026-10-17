/**
 * The thread under one Anmerkung: POST answers in it, and returns the
 * Anmerkung with its whole thread. Thin handler; the rules live in
 * `@/lib/annotations/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { roomPeerOf } from '@/lib/annotations/peer-header'
import { replyToAnnotation } from '@/lib/annotations/service'
import { createReplyRequestSchema } from '@/lib/annotations/types'

type Params = { id: string; annotationId: string }

export const POST = apiRoute<Params>(
  async ({ session, request, params }) =>
    replyToAnnotation(
      session,
      params.id,
      params.annotationId,
      await parseJsonBody(request, createReplyRequestSchema),
      { kind: 'person', peerId: roomPeerOf(request) }
    ),
  {
    authz: { enforcedBy: 'replyToAnnotation -> getAccessibleDocument (project:documents:write)' },
    status: 201,
  }
)
