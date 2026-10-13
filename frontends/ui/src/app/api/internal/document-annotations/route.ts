/**
 * INTERNAL — Piloti reads, proposes and answers Anmerkungen on the document
 * the conversation is about (CONTEXT.md „Anmerkung"). The agent's
 * `document_annotations` tool is the caller.
 *
 * The acting person is the one the turn's signed envelope names, as a pinned
 * session (ADR-0054 §4): the tool echoes the envelope, never signs one. The
 * document is the conversation's subject, resolved in `lib/annotations/agent.ts`,
 * never an id from the request. Piloti's marks are born proposals; only a
 * person takes one over (the CHECKs of migration 0135 hold that too).
 *
 * `POST` `InternalAnnotationRequest` → the `InternalAnnotation*Response` of its
 * op (`lib/annotations/types.ts`; JSON Schema in
 * `tests/fixtures/document-annotations.schema.json`).
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { resolveAgentSubject, runAgentAnnotationRequest } from '@/lib/annotations/agent'
import { internalAnnotationRequestSchema } from '@/lib/annotations/types'
import { withTenant } from '@/lib/db/tenant-context'

export const POST = internalApiRoute(
  'document-annotations',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, internalAnnotationRequestSchema)
    const session = await requirePinnedSession(context)
    return withTenant({ organizationId: context.organizationId }, async () => {
      const documentId = await resolveAgentSubject(context, body.answerMessageId ?? null)
      return runAgentAnnotationRequest(session, documentId, body)
    })
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
