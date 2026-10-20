import { z } from 'zod'
import type { UsageOverview } from './service'

// budget_policies stores numeric(12, 4).
export const platformOrgBudgetPutSchema = z.object({
  unit: z.enum(['credit', 'token']),
  dailyLimit: z.number().finite().min(0).max(99_999_999.9999).nullable(),
  monthlyLimit: z.number().finite().min(0).max(99_999_999.9999).nullable(),
  note: z.string().trim().max(500).nullable().optional(),
}).strict()

export type PlatformOrgBudgetInput = z.infer<typeof platformOrgBudgetPutSchema>

export interface PlatformOrgBudget {
  organizationId: string
  unit: PlatformOrgBudgetInput['unit']
  dailyLimit: number | null
  monthlyLimit: number | null
  explicit: boolean
  dayUsed: number
  monthUsed: number
  canManage: boolean
}

/**
 * One organization's Budgets view for the platform's drill-down
 * (`GET /api/platform/organizations/[id]/usage`): the office's own usage
 * answer, its name, and who its spenders are.
 */
export interface PlatformOrgUsage {
  organization: { id: string; name: string | null }
  /** The same shape `/api/organization/usage` answers a budget admin. */
  usage: UsageOverview
  /** Labels for `usage.perMember`; a member WorkOS no longer lists is absent. */
  members: Array<{ id: string; email: string; name: string | null }>
}
