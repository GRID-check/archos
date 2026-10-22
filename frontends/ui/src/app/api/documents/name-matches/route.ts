/**
 * The name probe (`@/lib/documents/name-probe-types`): which of these file
 * names one shelf already holds (`projectId`, or `scope: office_shelf`), asked
 * of the database the upload will ask. Thin handler.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { probeProjectDocumentNames } from '@/lib/documents/service'
import { nameProbeRequestSchema, type NameProbeResponse } from '@/lib/documents/name-probe-types'
import { shelfOf } from '@/lib/documents/shelf-scope'
import { probeOfficeShelfDocumentNames } from '@/lib/office-shelf/service'

export const POST = apiRoute(
  async ({ session, request }): Promise<NameProbeResponse> => {
    const { names, ...selector } = await parseJsonBody(request, nameProbeRequestSchema)
    const shelf = shelfOf(selector, request)
    return {
      documents:
        shelf.kind === 'project'
          ? await probeProjectDocumentNames(session, shelf.projectId, names)
          : await probeOfficeShelfDocumentNames(session, names),
    }
  },
  {
    authz: {
      enforcedBy:
        'probeProjectDocumentNames (requireProjectAccess project:view) | probeOfficeShelfDocumentNames (any member, scoped to session.organizationId)',
    },
  }
)
