/**
 * INTERNAL — the project intake's reading talks to the BFF (ADR-0111): what
 * the project still needs (`needs`), the values it found (`record`), a
 * suggestion of its own it takes back (`withdraw`), and that it has finished
 * (`finish`). The Erfassungs-Agent's tools are the callers.
 *
 * The acting person is the one the run's signed envelope names, as a pinned
 * session (ADR-0054 §4, ADR-0108): whoever's upload or click started the
 * reading. The project is the ENVELOPE's, never named in the body (each branch
 * is strict), so a captured envelope cannot write into another project. Every
 * op names the reading's `jobId`; one that is not the intake's current reading
 * answers 409 `stale-reading`.
 *
 * `POST` `InternalIntakeRequest` → the op's response
 * (`lib/project-intake/types.ts`; JSON Schema in
 * `tests/fixtures/project-intake.schema.json`).
 */

import { UnprocessableError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { withTenant } from '@/lib/db/tenant-context'
import {
  finishIntakeReading,
  intakeNeeds,
  recordIntakeValues,
  withdrawIntakeValues,
} from '@/lib/project-intake/service'
import { internalIntakeRequestSchema, type InternalIntakeResponse } from '@/lib/project-intake/types'

export const POST = internalApiRoute(
  'project-intake',
  async ({ request }): Promise<InternalIntakeResponse> => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, internalIntakeRequestSchema)
    const projectId = context.projectId
    if (!projectId) {
      throw new UnprocessableError('This reading is not in a project.', { reason: 'no-project' })
    }
    const session = await requirePinnedSession(context)
    return withTenant({ organizationId: context.organizationId }, async (): Promise<InternalIntakeResponse> => {
      switch (body.op) {
        case 'needs':
          return intakeNeeds(session, projectId, body.jobId)
        case 'record':
          return recordIntakeValues(session, projectId, body.jobId, body.values)
        case 'withdraw':
          return withdrawIntakeValues(session, projectId, body.jobId, body.keys)
        case 'finish':
          return finishIntakeReading(session, projectId, body.jobId, {
            summary: body.summary,
            documentsRead: body.documentsRead,
            traceId: body.traceId,
          })
      }
    })
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
