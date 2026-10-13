/**
 * INTERNAL — Piloti reads, proposes and answers Anmerkungen on the document
 * the conversation is about, or on one the turn names (CONTEXT.md
 * „Anmerkung"). The agent's canvas tools are the caller.
 *
 * The acting person is the one the turn's signed envelope names, as a pinned
 * session (ADR-0054 §4): the tool echoes the envelope, never signs one. The
 * document is the conversation's subject unless the turn names one, and a
 * named one is admitted only within the envelope's signed scope
 * (`lib/annotations/agent.ts`). Piloti's marks are born proposals; only a
 * person takes one over (the CHECKs of migration 0135 hold that too).
 *
 * `POST` `InternalAnnotationRequest` → the `InternalAnnotation*Response` of its
 * op (`lib/annotations/types.ts`; JSON Schema in
 * `tests/fixtures/document-annotations.schema.json`).
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { resolveAgentDocument, runAgentAnnotationRequest } from '@/lib/annotations/agent'
import { internalAnnotationRequestSchema } from '@/lib/annotations/types'
import { withTenant } from '@/lib/db/tenant-context'

export const POST = internalApiRoute(
  'document-annotations',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, internalAnnotationRequestSchema)
    const session = await requirePinnedSession(context)
    return withTenant({ organizationId: context.organizationId }, async () => {
      const document = await resolveAgentDocument(context, body.documentId ?? null, body.answerMessageId ?? null)
      return runAgentAnnotationRequest(session, document, body, {
        organizationId: context.organizationId,
        // resolveAgentDocument refuses a turn without a conversation.
        conversationId: context.conversationId ?? '',
        onBehalfOf: context.userId,
      })
    })
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
