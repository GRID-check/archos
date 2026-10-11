/**
 * Archiv API — which Archiv documents would these dropped names be the next
 * Fassung of?
 *
 * The org-wide twin of `POST /api/documents/fassung-candidates`, same contract
 * (`lib/documents/name-probe-types.ts`). Thin handler; the logic lives in
 * `@/lib/archiv/service` (ADR-0024).
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { probeArchivFassungCandidates } from '@/lib/archiv/service'
import { archivNameProbeRequestSchema } from '@/lib/documents/name-probe-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { names } = await parseJsonBody(request, archivNameProbeRequestSchema)
    return { candidates: await probeArchivFassungCandidates(session, names) }
  },
  {
    authz: {
      sessionOnly: true,
      why: "read-only probe of the caller's own org Archiv by file name; scoped by session.organizationId and the reader's holds, the same documents listArchiv already shows any member",
    },
  }
)
