/**
 * Move a project through its lifecycle (ADR-0098): pause, resume, close,
 * reopen. Thin handler; which moves exist, who may, and the audit trail live in
 * `setProjectStatus` (`@/lib/projects/service`). Closing names how the project
 * ended and its Abschluss month.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { setProjectStatus } from '@/lib/projects/service'
import { dateToMonth, isMonth, type Month } from '@/lib/projects/month'
import { PROJECT_OUTCOMES } from '@/lib/projects/project-status'

const monthSchema = z.custom<Month>((value) => typeof value === 'string' && isMonth(value), 'A month, YYYY-MM.')

const statusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('active') }),
  z.object({ status: z.literal('paused') }),
  z.object({
    status: z.literal('closed'),
    outcome: z.enum(PROJECT_OUTCOMES),
    endedOn: monthSchema,
  }),
])

export const PUT = apiRoute<{ id: string }>(
  async ({ session, params, request }) => {
    const change = await parseJsonBody(request, statusSchema)
    const project = await setProjectStatus(session, params.id, change, request)
    return {
      id: project.id,
      status: project.status,
      pausedAt: project.pausedAt?.toISOString() ?? null,
      closedAt: project.closedAt?.toISOString() ?? null,
      closedBy: project.closedBy,
      closedOutcome: project.closedOutcome,
      endedOn: dateToMonth(project.endedOn),
    }
  },
  { authz: { enforcedBy: 'setProjectStatus (requireProjectAccess project:manage, evenWhenClosed)' } }
)
