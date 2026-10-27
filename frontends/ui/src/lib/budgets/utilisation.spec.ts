/**
 * @vitest-environment node
 */
/**
 * `getBudgetUtilisation` keeps apart what `getBudgetStatus` folds into one
 * `remaining`: each LIMITED window of each applicable scope, with its limit and
 * what is used. `budget-events.ts` turns that into 80 / 100 % events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BudgetPolicy } from '@/lib/db/schema/budgets'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/organizations', () => ({ canManageBudgets: () => true }))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectTenancy: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))

const isOrgOnOwnKey = vi.fn(async (_organizationId: string) => false)
vi.mock('@/lib/llm-credentials/service', () => ({ isOrgOnOwnKey: (id: string) => isOrgOnOwnKey(id) }))

vi.mock('@/lib/pricing/service', () => ({
  getEffectivePricing: async () => ({ defaultOrgDailyCredits: 100, defaultOrgMonthlyCredits: 1000 }),
  getEffectivePricingOrBootFloor: async () => ({}),
  creditsToCostUsd: () => 0,
  priceUsage: () => ({}),
}))

vi.mock('@/lib/cache', () => ({
  getCached: async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
  invalidateCached: async () => {},
  invalidateCachedPrefix: async () => {},
}))

const findActivePolicy = vi.fn<(...args: unknown[]) => Promise<BudgetPolicy | null>>()
const sumRollupTotals = vi.fn()

vi.mock('./repository', () => ({
  findActivePolicy: (...args: unknown[]) => findActivePolicy(...args),
  sumRollupTotals: (...args: unknown[]) => sumRollupTotals(...args),
  utcDayStart: () => new Date(0),
  utcMonthStart: () => new Date(0),
  sumSpendWindows: () => ({}),
  EMPTY_SPEND_WINDOW: {},
}))

import { getBudgetUtilisation } from './service'

const policy = (over: Partial<BudgetPolicy>): BudgetPolicy =>
  ({ currency: 'credit', dailyLimit: null, monthlyLimit: null, ...over }) as BudgetPolicy

const window = (credits: number, tokens = 0) => ({ credits, tokens })

beforeEach(() => {
  vi.clearAllMocks()
  isOrgOnOwnKey.mockResolvedValue(false)
  findActivePolicy.mockResolvedValue(null)
  sumRollupTotals.mockResolvedValue({ day: window(30), month: window(400) })
})

describe('getBudgetUtilisation', () => {
  it('lists the seeded allowance of a platform-billed organization with no explicit policy', async () => {
    const usage = await getBudgetUtilisation('org_1', null, null)

    expect(usage).toEqual([
      { scope: 'organization', subjectId: null, unit: 'credit', window: 'day', limit: 100, used: 30 },
      { scope: 'organization', subjectId: null, unit: 'credit', window: 'month', limit: 1000, used: 400 },
    ])
  })

  it('leaves an unlimited window out instead of reporting it as 0 %', async () => {
    findActivePolicy.mockImplementation(async (_org, scope) =>
      scope === 'organization' ? policy({ dailyLimit: null, monthlyLimit: '500' }) : null,
    )

    const usage = await getBudgetUtilisation('org_1', null, null)

    expect(usage).toEqual([
      { scope: 'organization', subjectId: null, unit: 'credit', window: 'month', limit: 500, used: 400 },
    ])
  })

  it('adds the member and project scopes that have a policy, each summed over its own spend', async () => {
    findActivePolicy.mockImplementation(async (_org, scope) =>
      scope === 'organization' ? null : policy({ dailyLimit: '50', monthlyLimit: null }),
    )
    sumRollupTotals.mockImplementation(async (_org, filter: { userId?: string; projectId?: string }) =>
      filter.userId ? { day: window(45), month: window(0) } : filter.projectId ? { day: window(5), month: window(0) } : { day: window(30), month: window(400) },
    )

    const usage = await getBudgetUtilisation('org_1', 'user_1', 'proj_1')

    expect(usage).toContainEqual({ scope: 'member', subjectId: 'user_1', unit: 'credit', window: 'day', limit: 50, used: 45 })
    expect(usage).toContainEqual({ scope: 'project', subjectId: 'proj_1', unit: 'credit', window: 'day', limit: 50, used: 5 })
    expect(sumRollupTotals).toHaveBeenCalledWith('org_1', { userId: 'user_1' })
    expect(sumRollupTotals).toHaveBeenCalledWith('org_1', { projectId: 'proj_1' })
  })

  it('measures an own-key organization in tokens, not credits', async () => {
    isOrgOnOwnKey.mockResolvedValue(true)
    findActivePolicy.mockResolvedValue(policy({ currency: 'token', monthlyLimit: '10000' }))
    sumRollupTotals.mockResolvedValue({ day: window(30, 7), month: window(400, 9000) })

    const usage = await getBudgetUtilisation('org_1', null, null)

    expect(usage).toEqual([
      { scope: 'organization', subjectId: null, unit: 'token', window: 'month', limit: 10000, used: 9000 },
    ])
  })

  it('does not look up member or project spend for scopes without a policy', async () => {
    await getBudgetUtilisation('org_1', 'user_1', 'proj_1')

    expect(sumRollupTotals).toHaveBeenCalledTimes(1)
    expect(sumRollupTotals).toHaveBeenCalledWith('org_1', {})
  })
})
