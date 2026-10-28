/**
 * The revision probe (ADR-0099): for dropped file names, the documents of one
 * shelf (`projectId`, or `scope: office_shelf`) each would be the next revision
 * of. A project's probe also takes `folders`, where each name lands; the office
 * shelf has one collection and ignores it. Thin handler.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { probeProjectRevisionCandidates } from '@/lib/documents/revision-candidates'
import { revisionCandidatesRequestSchema, type RevisionCandidatesResponse } from '@/lib/documents/name-probe-types'
import { shelfOf } from '@/lib/documents/shelf-scope'
import { probeOfficeShelfRevisionCandidates } from '@/lib/office-shelf/service'

export const POST = apiRoute(
  async ({ session, request }): Promise<RevisionCandidatesResponse> => {
    const { names, folders, ...selector } = await parseJsonBody(request, revisionCandidatesRequestSchema)
    const shelf = shelfOf(selector, request)
    return {
      candidates:
        shelf.kind === 'project'
          ? await probeProjectRevisionCandidates(session, shelf.projectId, names, folders)
          : await probeOfficeShelfRevisionCandidates(session, names),
    }
  },
  {
    authz: {
      enforcedBy:
        'probeProjectRevisionCandidates (requireProjectAccess project:view) | probeOfficeShelfRevisionCandidates (any member, scoped to session.organizationId)',
    },
  }
)
