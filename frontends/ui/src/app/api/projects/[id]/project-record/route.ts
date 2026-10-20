/**
 * The Steckbrief of a project (ADR-0091): read it, or set its period. Thin
 * handlers; who may, and the audit trail, live in `project-record-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { getProjectRecord, setProjectPeriod } from '@/lib/projects/project-record-service'
import { projectPeriodSchema } from '@/lib/projects/project-record-types'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getProjectRecord(session, params.id), {
  authz: { enforcedBy: 'getProjectRecord (requireProjectAccess project:view)' },
})

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const period = await parseJsonBody(request, projectPeriodSchema)
    return setProjectPeriod(session, params.id, period, request)
  },
  { authz: { enforcedBy: 'setProjectPeriod (requireProjectAccess project:memory:write | project:edit)' } }
)
