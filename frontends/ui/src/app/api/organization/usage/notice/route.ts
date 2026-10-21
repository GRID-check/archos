/**
 * The chat's usage notice: the one budget window worth saying something about
 * before it stops this person, or `null` (`lib/budgets/usage-notice.ts`).
 *
 * Thin handler. The service drops a project the caller cannot see and decides
 * what the caller may change and read; every member may ask, because the
 * person a budget stops is usually not an admin.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getChatUsageNotice } from '@/lib/budgets/service'

const querySchema = z.object({
  projectId: z.string().max(120).optional(),
})

export const GET = apiRoute(
  async ({ session, request }) => ({ notice: await getChatUsageNotice(session, parseQuery(request, querySchema)) }),
  { authz: { enforcedBy: 'getChatUsageNotice (project:view on the project, canManageBudgets for amounts)' } }
)
