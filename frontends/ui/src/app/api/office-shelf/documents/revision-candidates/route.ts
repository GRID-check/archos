/**
 * Archiv API — which Archiv documents would these dropped names be the next
 * Fassung of?
 *
 * The org-wide twin of `POST /api/documents/revision-candidates`, same contract
 * (`lib/documents/name-probe-types.ts`). Thin handler; the logic lives in
 * `@/lib/office-shelf/service` (ADR-0024).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { probeOfficeShelfRevisionCandidates } from '@/lib/office-shelf/service'
import { officeShelfNameProbeRequestSchema } from '@/lib/documents/name-probe-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { names } = await parseJsonBody(request, officeShelfNameProbeRequestSchema)
    return { candidates: await probeOfficeShelfRevisionCandidates(session, names) }
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only probe of the caller's own org Archiv by file name; scoped by session.organizationId and the reader's holds, the same documents listOfficeShelf already shows any member",
    },
  }
)
