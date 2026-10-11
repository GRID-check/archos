/**
 * Archiv API — which of these filenames does the Archiv already hold?
 *
 * The upload planner's name probe for the org-wide shelf; the same contract as
 * `POST /api/documents/name-matches` (`lib/documents/name-probe-types.ts`).
 * Thin handler; all logic lives in `@/lib/archiv/service` (ADR-0024).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { probeArchivDocumentNames } from '@/lib/archiv/service'
import { archivNameProbeRequestSchema } from '@/lib/documents/name-probe-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { names } = await parseJsonBody(request, archivNameProbeRequestSchema)
    return { documents: await probeArchivDocumentNames(session, names) }
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only probe of the caller's own org Archiv by filename; scoped by session.organizationId, the same names listArchiv already shows any member",
    },
  }
)
