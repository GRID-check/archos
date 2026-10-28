/**
 * @vitest-environment node
 */
/**
 * Budget events for PostHog: what is sent, to whom, and that each window's
 * event is sent once however many usage batches and replicas notice it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const captureServer = vi.hoisted(() => vi.fn(() => true))
const enabled = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/analytics/posthog-server', () => ({
  captureServer,
  isPosthogServerEnabled: () => enabled.value,
}))

const getBudgetUtilisation = vi.hoisted(() => vi.fn())
vi.mock('./service', () => ({ getBudgetUtilisation }))

const withTenant = vi.hoisted(() =>
  vi.fn(async (_scope: { organizationId: string }, run: () => unknown) => await run()),
)
vi.mock('@/lib/db/tenant-context', () => ({ withTenant }))

import { setCacheStore, type CacheStore } from '@/lib/cache'
import {
  announceBudgetBlocked,
  announceBudgetThresholds,
  thresholdReached,
  type BudgetThreshold,
} from './budget-events'
import type { BudgetUtilisation } from './service'

/** A shared store that remembers what each key was set to and for how long. */
class MemoryStore implements CacheStore {
  entries = new Map<string, { value: string; ttlMs: number }>()
  async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.value ?? null
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, ttlMs })
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key)
  }
}

let store: MemoryStore

const usage = (over: Partial<BudgetUtilisation> = {}): BudgetUtilisation => ({
  scope: 'organization',
  subjectId: null,
  unit: 'credit',
  window: 'month',
  limit: 1000,
  used: 0,
  ...over,
})

const NOW = new Date('2026-10-10T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  enabled.value = true
  store = new MemoryStore()
  setCacheStore(store)
  getBudgetUtilisation.mockResolvedValue([])
})

describe('thresholdReached', () => {
  it.each<[number, number, BudgetThreshold | null]>([
    [0, 1000, null],
    [799, 1000, null],
    [800, 1000, 80],
    [999, 1000, 80],
    [1000, 1000, 100],
    [5000, 1000, 100],
    [0, 0, 100],
  ])('used %d of %d reaches %s', (used, limit, expected) => {
    expect(thresholdReached(used, limit)).toBe(expected)
  })
})

describe('announceBudgetBlocked', () => {
  const blocked = { organizationId: 'org_1', userId: 'user_1', scope: 'member', unit: 'credit' } as const

  it('sends budget_blocked as the refused person, with the scope and unit only', async () => {
    await announceBudgetBlocked(blocked)

    expect(captureServer).toHaveBeenCalledTimes(1)
    expect(captureServer).toHaveBeenCalledWith({
      event: 'budget_blocked',
      distinctId: 'user_1',
      organizationId: 'org_1',
      properties: { blocked_scope: 'member', unit: 'credit' },
    })
  })

  it('sends it once per person and scope while they keep reconnecting', async () => {
    await announceBudgetBlocked(blocked)
    await announceBudgetBlocked(blocked)
    await announceBudgetBlocked(blocked)

    expect(captureServer).toHaveBeenCalledTimes(1)
  })

  it('announces another person, another scope and another organization separately', async () => {
    await announceBudgetBlocked(blocked)
    await announceBudgetBlocked({ ...blocked, userId: 'user_2' })
    await announceBudgetBlocked({ ...blocked, scope: 'organization' })
    await announceBudgetBlocked({ ...blocked, organizationId: 'org_2' })

    expect(captureServer).toHaveBeenCalledTimes(4)
  })

  it('puts the organization in every cache key it writes, so one tenant never silences another', async () => {
    await announceBudgetBlocked(blocked)

    const keys = [...store.entries.keys()]
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(key).toContain('org_1')
  })

  it('is a no-op while PostHog is off: nothing sent, nothing cached', async () => {
    enabled.value = false

    await announceBudgetBlocked(blocked)

    expect(captureServer).not.toHaveBeenCalled()
    expect(store.entries.size).toBe(0)
  })

  it('never rejects, even when the cache store throws', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const down = new MemoryStore()
    down.get = async () => {
      throw new Error('redis down')
    }
    setCacheStore(down)

    await expect(announceBudgetBlocked(blocked)).resolves.toBeUndefined()
  })
})

describe('announceBudgetThresholds', () => {
  const batch = { organizationId: 'org_1', userId: 'user_1', projectId: 'proj_1', now: NOW }

  it('sends nothing while every window is under 80 %', async () => {
    getBudgetUtilisation.mockResolvedValue([usage({ used: 100 })])

    await announceBudgetThresholds(batch)

    expect(captureServer).not.toHaveBeenCalled()
  })

  it('sends the 80 % crossing personless, in the organization, with scope, window, unit and pct', async () => {
    getBudgetUtilisation.mockResolvedValue([usage({ used: 850 })])

    await announceBudgetThresholds(batch)

    expect(captureServer).toHaveBeenCalledTimes(1)
    expect(captureServer).toHaveBeenCalledWith({
      event: 'budget_threshold_crossed',
      distinctId: null,
      organizationId: 'org_1',
      properties: { scope: 'organization', window: 'month', pct: 80, unit: 'credit', subject_id: undefined },
    })
  })

  it('sends only the highest threshold reached: 100, not 80 as well', async () => {
    getBudgetUtilisation.mockResolvedValue([usage({ used: 1200 })])

    await announceBudgetThresholds(batch)

    expect(captureServer).toHaveBeenCalledTimes(1)
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ properties: expect.objectContaining({ pct: 100 }) }),
    )
  })

  it('sends each threshold once per window, however many batches land past it', async () => {
    getBudgetUtilisation.mockResolvedValue([usage({ used: 850 })])

    await announceBudgetThresholds(batch)
    await announceBudgetThresholds(batch)
    await announceBudgetThresholds(batch)
    expect(captureServer).toHaveBeenCalledTimes(1)

    // Then the same window reaches 100 %: a new fact, announced once.
    getBudgetUtilisation.mockResolvedValue([usage({ used: 1000 })])
    await announceBudgetThresholds(batch)
    await announceBudgetThresholds(batch)
    expect(captureServer).toHaveBeenCalledTimes(2)
  })

  it('announces again in the next window', async () => {
    getBudgetUtilisation.mockResolvedValue([usage({ used: 850 })])

    await announceBudgetThresholds(batch)
    await announceBudgetThresholds({ ...batch, now: new Date('2026-11-02T08:00:00Z') })

    expect(captureServer).toHaveBeenCalledTimes(2)
  })

  it('keeps the day window and the month window apart', async () => {
    getBudgetUtilisation.mockResolvedValue([
      usage({ window: 'day', limit: 100, used: 90 }),
      usage({ window: 'month', limit: 1000, used: 900 }),
    ])

    await announceBudgetThresholds(batch)

    const windows = captureServer.mock.calls.map(
      (call) => (call as unknown as [{ properties: { window: string } }])[0].properties.window,
    )
    expect(windows).toEqual(['day', 'month'])
  })

  it('names the project of a project budget and no id for a member budget', async () => {
    getBudgetUtilisation.mockResolvedValue([
      usage({ scope: 'project', subjectId: 'proj_1', used: 900 }),
      usage({ scope: 'member', subjectId: 'user_1', used: 900 }),
    ])

    await announceBudgetThresholds(batch)

    const props = captureServer.mock.calls.map(
      (call) => (call as unknown as [{ properties: Record<string, unknown> }])[0].properties,
    )
    expect(props[0]).toMatchObject({ scope: 'project', subject_id: 'proj_1' })
    expect(props[1]).toMatchObject({ scope: 'member', subject_id: undefined })
    expect(JSON.stringify(captureServer.mock.calls)).not.toContain('user_1')
  })

  it('keeps the dedupe keys per organization, and expires them after the window ends', async () => {
    getBudgetUtilisation.mockResolvedValue([usage({ used: 850 })])

    await announceBudgetThresholds(batch)
    await announceBudgetThresholds({ ...batch, organizationId: 'org_2' })

    expect(captureServer).toHaveBeenCalledTimes(2)
    for (const [key, entry] of store.entries) {
      expect(key).toMatch(/org_[12]/)
      // 2026-10-10 12:00 to month end plus the grace hour.
      expect(entry.ttlMs).toBeGreaterThan(20 * 24 * 3_600_000)
      expect(entry.ttlMs).toBeLessThan(23 * 24 * 3_600_000)
    }
  })

  it('reads the ledger as the organization, because RLS needs a tenant', async () => {
    await announceBudgetThresholds(batch)

    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
    expect(getBudgetUtilisation).toHaveBeenCalledWith('org_1', 'user_1', 'proj_1')
  })

  it('is a no-op while PostHog is off: the ledger is not even read', async () => {
    enabled.value = false

    await announceBudgetThresholds(batch)

    expect(getBudgetUtilisation).not.toHaveBeenCalled()
    expect(captureServer).not.toHaveBeenCalled()
  })

  it('never rejects when the ledger read fails', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    getBudgetUtilisation.mockRejectedValue(new Error('db down'))

    await expect(announceBudgetThresholds(batch)).resolves.toBeUndefined()
    expect(captureServer).not.toHaveBeenCalled()
  })
})
