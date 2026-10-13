/**
 * One Anmerkung of a document: PATCH changes it (take a proposal over or
 * dismiss it, resolve or reopen it, reword it, assign it, give it a date),
 * DELETE removes one the caller set. Thin handlers; the rules live in
 * `@/lib/annotations/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { roomPeerOf } from '@/lib/annotations/peer-header'
import { deleteAnnotation, updateAnnotation } from '@/lib/annotations/service'
import { updateAnnotationRequestSchema } from '@/lib/annotations/types'

type Params = { id: string; annotationId: string }

export const PATCH = apiRoute<Params>(
  async ({ session, request, params }) =>
    updateAnnotation(
      session,
      params.id,
      params.annotationId,
      await parseJsonBody(request, updateAnnotationRequestSchema),
      { kind: 'person', peerId: roomPeerOf(request) }
    ),
  { authz: { enforcedBy: 'updateAnnotation -> getAccessibleDocument (project:documents:write)' } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, request, params }) =>
    deleteAnnotation(session, params.id, params.annotationId, { kind: 'person', peerId: roomPeerOf(request) }),
  { authz: { enforcedBy: 'deleteAnnotation -> getAccessibleDocument (project:documents:write), own marks only' } }
)
