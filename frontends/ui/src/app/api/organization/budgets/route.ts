/**
 * LLM budget policies, in the organization's unit (ADR-0053): credits for a
 * platform-billed organization, tokens for one on its own key. The caller
 * never picks the unit — it follows the key mode — so the body carries bare
 * `dailyLimit` / `monthlyLimit` and the response says which unit they are in.
 *
 * GET — members see the org limits + their own member limit; budget admins
 *       additionally get every active member/project policy.
 * PUT — sets a policy. Org and member scopes: budget admins only. Project
 *       scope: budget admins or that project's admins.
 * DELETE — removes a scoped limit (fall back to the org limits alone).
 *
 * Thin handlers; gating, validation (422), and the audit trail live in
 * `@/lib/budgets/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { budgetDeleteSchema, budgetPutSchema } from '@/lib/organizations/organization-wire'
import { getBudgetOverview, removeBudgetPolicy, saveBudgetPolicy } from '@/lib/budgets/service'

export const GET = apiRoute(async ({ session }) => getBudgetOverview(session), {
  authz: { enforcedBy: 'getBudgetOverview (canManageBudgets, else own-limits only)' },
})

export const PUT = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, budgetPutSchema)
    return { policy: await saveBudgetPolicy(session, input, request) }
  },
  {
    status: 201,
    authz: {
      enforcedBy: 'saveBudgetPolicy (canManageBudgets or project:manage for project scope)',
    },
  }
)

export const DELETE = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, budgetDeleteSchema)
    return { removed: await removeBudgetPolicy(session, input, request) }
  },
  {
    authz: {
      enforcedBy: 'removeBudgetPolicy (canManageBudgets or project:manage for project scope)',
    },
  }
)
