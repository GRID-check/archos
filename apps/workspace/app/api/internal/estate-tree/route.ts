/**
 * INTERNAL: the estate tree (ADR-0133 slice 7). One shelf of the turn's estate
 * (its project, the office shelf, the conversation's own files) as the
 * conversation's whole audience may list it: every folder, empty ones too, with
 * its description and whether it has a card, and a page of documents. The
 * agent's estate backend calls it to serve `ls` and `glob`
 * (`docs/architecture/agent-filesystem.md` §5).
 *
 * The acting person is the one the turn's signed envelope names, as a pinned
 * session (ADR-0054 §4); the agent echoes the envelope, never signs one. The
 * project and the conversation are the envelope's, never the body's. What the
 * audience may list is the search's reach (`reachForAudience`); this route only
 * adapts. Restricted folders and held uploads are absent, not marked; a refusal
 * is a 404 that reads like a missing folder.
 *
 * `POST` `EstateTreeRequest` → `EstateTreeResponse` (`lib/estate-tree/types.ts`,
 * JSON Schema in `tests/fixtures/estate-tree.schema.json`).
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { withTenant } from '@/lib/db/tenant-context'
import { readEstateTree } from '@/lib/estate-tree/service'
import { estateTreeRequestSchema } from '@/lib/estate-tree/types'

export const POST = internalApiRoute(
  'estate-tree',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, estateTreeRequestSchema)
    const session = await requirePinnedSession(context)
    return withTenant({ organizationId: context.organizationId, userId: context.userId }, () =>
      readEstateTree(context, session, body),
    )
  },
  { tenancy: { fromPayload: 'the signed request-context envelope, never the body' } },
)
