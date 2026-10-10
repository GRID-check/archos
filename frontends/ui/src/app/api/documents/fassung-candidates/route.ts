/**
 * Documents API — which documents of the project would these dropped names be
 * the next Fassung of?
 *
 * The upload dialog's „Als neue Fassung von X ablegen" (ADR-0098); the client is
 * `lib/documents/name-probe-client.ts`, the contract `name-probe-types.ts`. Asked
 * with the name probe's body and gated like it. POST because a folder drop
 * carries up to two thousand names. Thin handler; the logic lives in
 * `@/lib/documents/fassung-candidates`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { probeProjectFassungCandidates } from '@/lib/documents/fassung-candidates'
import { projectNameProbeRequestSchema, type FassungCandidatesResponse } from '@/lib/documents/name-probe-types'

export const POST = apiRoute(
  async ({ session, request }): Promise<FassungCandidatesResponse> => {
    const { projectId, names } = await parseJsonBody(request, projectNameProbeRequestSchema)
    return { candidates: await probeProjectFassungCandidates(session, projectId, names) }
  },
  { authz: { enforcedBy: 'probeProjectFassungCandidates (requireProjectAccess project:view)' } }
)
