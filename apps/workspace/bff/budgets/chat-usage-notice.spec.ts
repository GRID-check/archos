/**
 * @vitest-environment node
 */
/**
 * `getChatUsageNotice` is the decision plus the viewer's rights: a project the
 * viewer cannot see is dropped, `canChange` and the link follow who may move the
 * binding limit, and amounts travel only to someone who may already read them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BudgetPolicy } from '@/lib/db/schema/budgets'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))
const canManageBudgets = vi.fn(() => false)
vi.mock('@/lib/authz/organizations', () => ({ canManageBudgets: () => canManageBudgets() }))
const can = vi.fn(async (_session: unknown, _permission: string, _resource?: unknown) => true)
vi.mock('@/lib/authz/decide', () => ({ can: (...args: [unknown, string, unknown]) => can(...args) }))
vi.mock('@/lib/authz/project-membership', () => ({ resolveSubjectMembership: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectTenancy: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/llm-credentials/service', () => ({ isOrgOnOwnKey: async () => false }))
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

import { getChatUsageNotice } from './service'

const NOW = new Date('2026-10-21T12:00:00Z')
const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession
const totals = (day: number, month: number) => ({ day: { credits: day, tokens: 0 }, month: { credits: month, tokens: 0 } })
const projectPolicy = { currency: 'credit', dailyLimit: null, monthlyLimit: '200' } as BudgetPolicy

beforeEach(() => {
  vi.clearAllMocks()
  canManageBudgets.mockReturnValue(false)
  can.mockResolvedValue(true)
  findActivePolicy.mockResolvedValue(null)
  // The organization's seeded allowance: 100 a day, 1000 a month.
  sumRollupTotals.mockImplementation(async (_org: string, filter: { projectId?: string }) =>
    filter.projectId ? totals(0, 196) : totals(10, 100),
  )
})

describe('getChatUsageNotice', () => {
  it('is null while every window is comfortably within its limit', async () => {
    expect(await getChatUsageNotice(session, {}, NOW)).toBeNull()
  })

  it('tells a member about the office budget in percent, with no amounts and no edit link', async () => {
    sumRollupTotals.mockResolvedValue(totals(85, 100))
    expect(await getChatUsageNotice(session, {}, NOW)).toEqual({
      level: 'warning',
      scope: 'organization',
      window: 'day',
      unit: 'credit',
      percent: 85,
      amounts: null,
      resetsAt: '2026-10-22T00:00:00.000Z',
      runsOutAt: null,
      canChange: false,
      href: '/app/organization/budgets',
      key: 'organization::day:2026-10-21:warning',
    })
  })

  it('gives a budget admin the amounts and the right to change the limit', async () => {
    canManageBudgets.mockReturnValue(true)
    sumRollupTotals.mockResolvedValue(totals(100, 100))
    expect(await getChatUsageNotice(session, {}, NOW)).toMatchObject({
      level: 'exhausted',
      amounts: { used: 100, limit: 100 },
      canChange: true,
    })
  })

  it('shows a member their own limit in amounts', async () => {
    findActivePolicy.mockImplementation(async (_org, scope) =>
      scope === 'member' ? ({ currency: 'credit', dailyLimit: '20', monthlyLimit: null } as BudgetPolicy) : null,
    )
    sumRollupTotals.mockImplementation(async (_org: string, filter: { userId?: string }) =>
      filter.userId ? totals(19, 19) : totals(19, 100),
    )
    expect(await getChatUsageNotice(session, {}, NOW)).toMatchObject({
      level: 'critical',
      scope: 'member',
      amounts: { used: 19, limit: 20 },
      canChange: false,
    })
  })

  it('links a project admin to the project settings for a project budget', async () => {
    findActivePolicy.mockImplementation(async (_org, scope) => (scope === 'project' ? projectPolicy : null))
    const notice = await getChatUsageNotice(session, { projectId: 'proj-1' }, NOW)
    expect(notice).toMatchObject({
      level: 'critical',
      scope: 'project',
      canChange: true,
      href: '/app/projects/proj-1/settings/usage',
      amounts: { used: 196, limit: 200 },
      key: 'project:proj-1:month:2026-10:critical',
    })
    expect(can).toHaveBeenCalledWith(session, 'project:manage', { type: 'project', id: 'proj-1' })
  })

  it('sends a project member without project:manage to the usage page, without amounts', async () => {
    findActivePolicy.mockImplementation(async (_org, scope) => (scope === 'project' ? projectPolicy : null))
    can.mockImplementation(async (_s, permission) => permission === 'project:view')
    expect(await getChatUsageNotice(session, { projectId: 'proj-1' }, NOW)).toMatchObject({
      scope: 'project',
      canChange: false,
      href: '/app/organization/budgets',
      amounts: null,
    })
  })

  it('never reads the budget of a project the viewer cannot see', async () => {
    findActivePolicy.mockImplementation(async (_org, scope) => (scope === 'project' ? projectPolicy : null))
    can.mockResolvedValue(false)
    expect(await getChatUsageNotice(session, { projectId: 'proj-hidden' }, NOW)).toBeNull()
    expect(findActivePolicy).not.toHaveBeenCalledWith('org-1', 'project', 'proj-hidden', expect.anything())
  })
})
