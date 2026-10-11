/**
 * Archiv API — which Archiv documents would these dropped names be the next
 * Fassung of?
 *
 * The org-wide twin of `POST /api/documents/fassung-candidates`, same contract
 * (`lib/documents/name-probe-types.ts`). Thin handler; the logic lives in
 * `@/lib/archiv/service`. Feature-gated by the dark-launch `organization-archiv`
 * flag (ADR-0024), like the name probe.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { probeArchivFassungCandidates } from '@/lib/archiv/service'
import { archivNameProbeRequestSchema } from '@/lib/documents/name-probe-types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.orgArchiv)
    if (gated) return gated
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
