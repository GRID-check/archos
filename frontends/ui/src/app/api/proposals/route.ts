/**
 * A shelf's open proposed changes (ADR-0105): `GET ?projectId=<id>` for a
 * project's, `?shelf=archiv` for the Büroablage's, optionally `&kind=`, `&limit=` and `&cursor=` (the previous page's `nextCursor`). Each
 * comes with the documents it names, resolved to ids as the reader sees them,
 * so the Files workspace finds a file row's suggestion by document id. Thin
 * handler; the rules live in `@/lib/proposals/service`, the contract in
 * `@/lib/proposals/types`, the client in `@/lib/proposals/client`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listOpenProposals } from '@/lib/proposals/service'
import { proposalListQuerySchema, type ProposalListResponse } from '@/lib/proposals/types'

export const GET = apiRoute(
  async ({ session, request }): Promise<ProposalListResponse> =>
    listOpenProposals(session, parseQuery(request, proposalListQuerySchema)),
  {
    authz: {
      enforcedBy:
        'listOpenProposals (requireProjectAccess project:view on a project shelf; per row: viewer on its conversation, or every document it names resolvable for the reader)',
    },
  }
)
