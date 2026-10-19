/**
 * INTERNAL — Piloti proposes a change to the workspace (ADR-0105): a file
 * operation, a memory note, or a change to the project's profile, by `kind`.
 * The agent's tools are the callers; the card they emit carries the id this
 * returns, and a person applies or dismisses it through `/api/proposals/[id]`.
 * With `answerMessageId` and `originCardIndex` the create is idempotent: the
 * same card again returns the first proposal.
 *
 * The acting person is the one the turn's signed envelope names, as a pinned
 * session (ADR-0054 §4): the tool echoes the envelope, never signs one. The
 * project is the ENVELOPE's, never named in the body (the schema is strict),
 * so a captured envelope cannot file a proposal into another project. The
 * conversation is the envelope's too. Proposing changes nothing; the asker
 * must be able to read the project, and whoever decides needs write.
 *
 * `POST` `InternalProposalRequest` → `InternalProposalResponse`
 * (`lib/proposals/types.ts`; JSON Schema in
 * `tests/fixtures/proposals.schema.json`).
 */

import { UnprocessableError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { withTenant } from '@/lib/db/tenant-context'
import { createProposal } from '@/lib/proposals/service'
import { internalProposalRequestSchema, type InternalProposalResponse } from '@/lib/proposals/types'

export const POST = internalApiRoute(
  'proposals',
  async ({ request }): Promise<InternalProposalResponse> => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, internalProposalRequestSchema)
    const projectId = context.projectId
    if (!projectId) {
      throw new UnprocessableError('This conversation is not in a project. Workspace changes are proposed in one.', {
        reason: 'no-project',
      })
    }
    const session = await requirePinnedSession(context)
    return withTenant({ organizationId: context.organizationId }, async () => {
      const row = await createProposal(session, {
        projectId,
        kind: body.kind,
        payload: body.payload,
        conversationId: context.conversationId,
        answerMessageId: body.answerMessageId ?? null,
        originCardIndex: body.originCardIndex ?? null,
      })
      return { id: row.id, status: row.status }
    })
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } },
)
