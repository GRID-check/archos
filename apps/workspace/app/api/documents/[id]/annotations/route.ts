/**
 * A document's Anmerkungen (CONTEXT.md „Anmerkung", migration 0138).
 *
 * GET lists them, each with its thread, and whether the reader may set one;
 * POST sets one, a point or a region, on the Fassung the document shows now.
 * Thin handlers: access, the assignee check and the numbering live in
 * `@/lib/annotations/service`; the typed client is `@/lib/annotations/client`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { MAX_CREATE_BODY_BYTES } from '@/lib/annotations/viewpoint-types'
import { roomPeerOf } from '@/lib/annotations/peer-header'
import { createAnnotation, listAnnotations } from '@/lib/annotations/service'
import { createAnnotationRequestSchema } from '@/lib/annotations/types'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => listAnnotations(session, params.id), {
  authz: { enforcedBy: 'listAnnotations -> getAccessibleDocument (read)' },
})

export const POST = apiRoute<Params>(
  async ({ session, request, params }) =>
    createAnnotation(session, params.id, await parseJsonBody(request, createAnnotationRequestSchema, { maxBytes: MAX_CREATE_BODY_BYTES }), {
      kind: 'person',
      peerId: roomPeerOf(request),
    }),
  {
    authz: { enforcedBy: 'createAnnotation -> getAccessibleDocument (project:documents:write)' },
    status: 201,
  }
)
