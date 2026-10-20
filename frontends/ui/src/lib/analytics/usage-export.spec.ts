/**
 * @vitest-environment node
 */
/**
 * The PostHog usage export: which hours a run sends, what each event carries,
 * and that the cursor moves only after PostHog took the events, so an hour is
 * neither lost nor counted twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const batch = vi.hoisted(() => ({
  capture: vi.fn(),
  flush: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}))
const enabled = vi.hoisted(() => ({ value: true }))
vi.mock('./posthog-server', () => ({
  createPosthogBatch: () => (enabled.value ? batch : null),
}))

const repo = vi.hoisted(() => ({
  claimCursor: vi.fn(),
  advanceCursor: vi.fn(async () => undefined),
  releaseCursor: vi.fn(async () => undefined),
  sumUsageByHour: vi.fn(),
  listSnapshotOrganizations: vi.fn(async () => [] as string[]),
}))
vi.mock('./usage-export-repository', () => repo)

const budgets = vi.hoisted(() => ({
  getOrgBudgetUnit: vi.fn(async () => 'credit'),
  getOrgBudget: vi.fn(),
  getSpendSummary: vi.fn(),
  getBudgetStatus: vi.fn(),
  listActivePolicies: vi.fn(async () => []),
}))
vi.mock('@/lib/budgets/service', () => budgets)
vi.mock('@/lib/organizations/service', () => ({ getOrganizationDisplayName: vi.fn(async () => 'Büro Nord') }))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: async (_scope: unknown, run: () => unknown) => await run(),
  withPlatformAccess: async (_reason: string, run: () => unknown) => await run(),
}))

import type { UsageHourRow } from './usage-export-repository'
import { BACKFILL_DAYS, MAX_HOURS_PER_RUN, exportUsageToPosthog, exportWindow, usageHourProperties } from './usage-export'

const HOUR = 60 * 60_000

const row = (over: Partial<UsageHourRow> = {}): UsageHourRow => ({
  organizationId: 'org_1',
  hour: new Date('2026-10-20T06:00:00Z'),
  model: 'anthropic/claude-haiku-5.5',
  activity: null,
  agentGroup: null,
  userId: 'user_1',
  projectId: 'p1',
  ownKey: false,
  calls: 4,
  promptTokens: 1000,
  completionTokens: 200,
  cachedTokens: 100,
  reasoningTokens: 50,
  totalTokens: 1200,
  costUsd: 0.012,
  priceUsd: 0.03,
  credits: 3,
  audioSeconds: 0,
  ...over,
})

const window = (counts: Record<string, unknown>) => ({ day: { ...counts }, month: { ...counts } })

beforeEach(() => {
  vi.clearAllMocks()
  enabled.value = true
  repo.listSnapshotOrganizations.mockResolvedValue([])
  budgets.getOrgBudgetUnit.mockResolvedValue('credit')
})

describe('exportWindow', () => {
  const now = new Date('2026-10-20T08:05:00Z')

  it('stops at the last hour that closed ten minutes ago', () => {
    // 08:05 is inside 08:00's settle time, so 07:00–08:00 is not closed yet.
    expect(exportWindow(new Date('2026-10-20T05:00:00Z'), now)).toEqual({
      from: new Date('2026-10-20T05:00:00Z'),
      to: new Date('2026-10-20T07:00:00Z'),
    })
  })

  it('has nothing to send when the cursor is at the last closed hour', () => {
    expect(exportWindow(new Date('2026-10-20T07:00:00Z'), now)).toBeNull()
  })

  it('sends a backfill a bounded window at a time', () => {
    const from = new Date(now.getTime() - BACKFILL_DAYS * 24 * HOUR)
    const sent = exportWindow(from, now)
    expect(sent && (sent.to.getTime() - sent.from.getTime()) / HOUR).toBe(MAX_HOURS_PER_RUN)
  })
})

describe('usageHourProperties', () => {
  it('counts credits for an office the platform bills, and names what the hour was', () => {
    expect(usageHourProperties(row(), 'credit')).toMatchObject({
      hour: '2026-10-20T06:00:00.000Z',
      model: 'anthropic/claude-haiku-5.5',
      activity: 'chat',
      purpose: 'agent',
      user_id: 'user_1',
      project_id: 'p1',
      own_key: false,
      billed: true,
      unit: 'credit',
      amount: 3,
      calls: 4,
      total_tokens: 1200,
      cost_usd: 0.012,
      price_usd: 0.03,
    })
  })

  it('counts tokens for an office on its own key, as its Budgets page does', () => {
    expect(usageHourProperties(row({ ownKey: true, credits: 0 }), 'token')).toMatchObject({ unit: 'token', amount: 1200 })
  })

  it('marks dictation unbilled', () => {
    const props = usageHourProperties(row({ activity: 'dictation', credits: 0, audioSeconds: 12.5 }), 'credit')
    expect(props).toMatchObject({ activity: 'dictation', billed: false, audio_seconds: 12.5 })
  })

  it('carries no free text: every value is a scalar of our own', () => {
    for (const value of Object.values(usageHourProperties(row(), 'credit'))) {
      expect(['string', 'number', 'boolean', 'undefined']).toContain(typeof value)
    }
  })
})

describe('exportUsageToPosthog', () => {
  const now = new Date('2026-10-20T08:15:00Z')

  it('reads nothing while PostHog is off', async () => {
    enabled.value = false
    expect(await exportUsageToPosthog(now)).toEqual({ enabled: false, usage: null, snapshot: null })
    expect(repo.claimCursor).not.toHaveBeenCalled()
  })

  it('sends the closed hours, stamped with their hour, and moves the cursor after the flush', async () => {
    repo.claimCursor.mockResolvedValueOnce(new Date('2026-10-20T06:00:00Z')).mockResolvedValueOnce(null)
    repo.sumUsageByHour.mockResolvedValue([row(), row({ model: 'openai/gpt-6-sol' })])

    const result = await exportUsageToPosthog(now)

    expect(repo.sumUsageByHour).toHaveBeenCalledWith(new Date('2026-10-20T06:00:00Z'), new Date('2026-10-20T08:00:00Z'))
    expect(batch.capture).toHaveBeenCalledTimes(2)
    expect(batch.capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'llm_usage_hourly',
      distinctId: null,
      organizationId: 'org_1',
      timestamp: new Date('2026-10-20T06:00:00Z'),
    })
    expect(batch.flush.mock.invocationCallOrder[0]).toBeLessThan(repo.advanceCursor.mock.invocationCallOrder[0] ?? 0)
    expect(repo.advanceCursor).toHaveBeenCalledWith('posthog_usage_hourly', new Date('2026-10-20T08:00:00Z'), now)
    expect(result.usage).toEqual({
      from: '2026-10-20T06:00:00.000Z',
      to: '2026-10-20T08:00:00.000Z',
      rows: 2,
      caughtUp: true,
    })
    expect(batch.close).toHaveBeenCalled()
  })

  it('leaves the cursor where it was when PostHog refused the send', async () => {
    repo.claimCursor.mockResolvedValueOnce(new Date('2026-10-20T06:00:00Z'))
    repo.sumUsageByHour.mockResolvedValue([row()])
    batch.flush.mockRejectedValueOnce(new Error('503'))

    await expect(exportUsageToPosthog(now)).rejects.toThrow('503')

    expect(repo.advanceCursor).not.toHaveBeenCalled()
    expect(repo.releaseCursor).toHaveBeenCalledWith('posthog_usage_hourly', now)
    expect(batch.close).toHaveBeenCalled()
  })

  it('sends nothing for a stream another run holds', async () => {
    repo.claimCursor.mockResolvedValue(null)

    expect(await exportUsageToPosthog(now)).toEqual({ enabled: true, usage: null, snapshot: null })
    expect(batch.capture).not.toHaveBeenCalled()
  })

  it('snapshots each organization once an hour with its limits and how much of them is used', async () => {
    repo.claimCursor.mockResolvedValueOnce(null).mockResolvedValueOnce(new Date('2026-10-20T07:00:00Z'))
    repo.listSnapshotOrganizations.mockResolvedValue(['org_1'])
    budgets.getOrgBudget.mockResolvedValue({ dailyLimit: 100, monthlyLimit: 1000, explicit: false })
    budgets.getSpendSummary.mockResolvedValue({
      ...window({ credits: 0, tokens: 0, events: 0, costUsd: 0, priceUsd: 0 }),
      day: { credits: 25, tokens: 9000, events: 10, costUsd: 0.1, priceUsd: 0.25 },
      month: { credits: 800, tokens: 300000, events: 400, costUsd: 3.2, priceUsd: 8 },
      perModel: [],
    })
    budgets.getBudgetStatus.mockResolvedValue({ blocked: false, blockedScope: null })

    const result = await exportUsageToPosthog(now)

    expect(result.snapshot).toEqual({ hour: '2026-10-20T08:00:00.000Z', organizations: 1 })
    expect(batch.capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'organization_budget_snapshot',
      organizationId: 'org_1',
      properties: {
        organization_name: 'Büro Nord',
        unit: 'credit',
        daily_limit: 100,
        monthly_limit: 1000,
        limits_explicit: false,
        day_amount: 25,
        month_amount: 800,
        day_pct: 25,
        month_pct: 80,
        blocked: false,
      },
    })
    expect(repo.advanceCursor).toHaveBeenCalledWith('posthog_budget_snapshot', new Date('2026-10-20T08:00:00Z'), now)
  })

  it('does not snapshot an hour twice', async () => {
    repo.claimCursor.mockResolvedValueOnce(null).mockResolvedValueOnce(new Date('2026-10-20T08:00:00Z'))

    expect((await exportUsageToPosthog(now)).snapshot).toBeNull()
    expect(repo.listSnapshotOrganizations).not.toHaveBeenCalled()
    expect(repo.releaseCursor).toHaveBeenCalledWith('posthog_budget_snapshot', now)
  })
})
