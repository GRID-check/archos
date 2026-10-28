/**
 * People a collaborator may assign — project members, not org-admin-only.
 * Distinct from share invite candidates (owner). Assignment is not access.
 *
 * `?access=write` (a document only) lists who may change it rather than open
 * it: the people an Anmerkung may be handed to, since its Zuständige answers
 * and closes it. Without it, who may open it: a document's assignee, and whom
 * a mark may mention.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { assignmentCandidatesQuerySchema } from '@/lib/assignments/assignment-wire'
import { listAssignmentCandidates } from '@/lib/assignments/service'
import { requireShareableType } from '@/lib/sharing/registry'

type Params = { resourceType: string; resourceId: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const candidates = await listAssignmentCandidates(
      session,
      requireShareableType(params.resourceType),
      params.resourceId,
      { access: parseQuery(request, assignmentCandidatesQuerySchema).access ?? 'read' },
    )
    return { candidates }
  },
  { authz: { enforcedBy: 'listAssignmentCandidates (requireResourceAccess collaborator)' } },
)
