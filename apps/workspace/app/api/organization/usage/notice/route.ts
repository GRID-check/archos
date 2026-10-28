/**
 * The chat's usage notice: the one budget window worth saying something about
 * before it stops this person, or `null` (`lib/budgets/usage-notice.ts`).
 *
 * Thin handler. The service drops a project the caller cannot see and decides
 * what the caller may change and read; every member may ask, because the
 * person a budget stops is usually not an admin.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getChatUsageNotice } from '@/lib/budgets/service'
import { usageNoticeQuerySchema } from '@/lib/organizations/organization-wire'

export const GET = apiRoute(
  async ({ session, request }) => ({ notice: await getChatUsageNotice(session, parseQuery(request, usageNoticeQuerySchema)) }),
  { authz: { enforcedBy: 'getChatUsageNotice (project:view on the project, canManageBudgets for amounts)' } }
)
