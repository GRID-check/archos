/**
 * Opt-in integration test: the PostHog usage export's SQL against a REAL
 * Postgres with the whole migration chain applied, as the restricted runtime
 * role. The cursor is claimed once while a run holds it, moves only when told
 * to, and the hourly sum puts each ledger row in its own UTC hour. Runs under
 * `task db:test:rls`; skipped unless TEST_DATABASE_URL is set.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('usage export repository against live Postgres', () => {
  const asPlatform = async <T>(run: () => Promise<T>): Promise<T> => {
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    return withPlatformAccess('usage export integration spec', run)
  }

  beforeAll(() => {
    process.env.APP_DATABASE_URL = url
  })

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('claims the cursor once, and moves it only on advance', async () => {
    const { advanceCursor, claimCursor, releaseCursor } = await import('./usage-export-repository')
    const now = new Date('2026-10-20T08:15:00Z')
    const horizon = new Date('2026-07-22T08:00:00Z')

    const first = await asPlatform(() => claimCursor('posthog_usage_hourly', horizon, 600_000, now))
    expect(first?.toISOString()).toBe(horizon.toISOString())
    // Held: a second run gets nothing.
    expect(await asPlatform(() => claimCursor('posthog_usage_hourly', horizon, 600_000, now))).toBeNull()

    await asPlatform(() => releaseCursor('posthog_usage_hourly', now))
    const again = await asPlatform(() => claimCursor('posthog_usage_hourly', horizon, 600_000, now))
    expect(again?.toISOString()).toBe(horizon.toISOString())

    const through = new Date('2026-07-24T08:00:00Z')
    await asPlatform(() => advanceCursor('posthog_usage_hourly', through, now))
    const next = await asPlatform(() => claimCursor('posthog_usage_hourly', horizon, 600_000, now))
    expect(next?.toISOString()).toBe(through.toISOString())

    // A lease that ran out can be taken over.
    const later = new Date(now.getTime() + 11 * 60_000)
    expect((await asPlatform(() => claimCursor('posthog_usage_hourly', horizon, 600_000, later)))?.toISOString()).toBe(
      through.toISOString(),
    )
    await asPlatform(() => releaseCursor('posthog_usage_hourly', later))
  })

  it('sums the ledger per organization and UTC hour, across tenants', async () => {
    const { recordUsageEvents } = await import('@/lib/budgets/service')
    const { withTenant } = await import('@/lib/db/tenant-context')
    const { sumUsageByHour } = await import('./usage-export-repository')

    const orgA = `org_export_a_${Date.now()}`
    const orgB = `org_export_b_${Date.now()}`
    const row = (organizationId: string, createdAt: Date, totalTokens: number) => ({
      organizationId,
      userId: 'user_1',
      projectId: null,
      conversationId: null,
      jobId: null,
      model: 'anthropic/claude-haiku-5.5',
      promptTokens: totalTokens,
      completionTokens: 0,
      totalTokens,
      costUsd: '0.01000000',
      costSource: 'usage_field' as const,
      createdAt,
    })
    await withTenant({ organizationId: orgA }, () =>
      recordUsageEvents([
        row(orgA, new Date('2026-10-20T06:10:00Z'), 100),
        row(orgA, new Date('2026-10-20T06:50:00Z'), 50),
        row(orgA, new Date('2026-10-20T07:05:00Z'), 10),
      ]),
    )
    await withTenant({ organizationId: orgB }, () => recordUsageEvents([row(orgB, new Date('2026-10-20T06:20:00Z'), 7)]))

    const rows = (
      await asPlatform(() => sumUsageByHour(new Date('2026-10-20T06:00:00Z'), new Date('2026-10-20T07:00:00Z')))
    ).filter((entry) => entry.organizationId === orgA || entry.organizationId === orgB)

    expect(rows.map((entry) => [entry.organizationId, entry.hour.toISOString(), entry.calls, entry.totalTokens]).sort()).toEqual(
      [
        [orgA, '2026-10-20T06:00:00.000Z', 2, 150],
        [orgB, '2026-10-20T06:00:00.000Z', 1, 7],
      ].sort(),
    )
    // Boot-floor pricing: one credit is one US cent of cost.
    expect(rows.find((entry) => entry.organizationId === orgA)?.credits).toBeCloseTo(2, 6)
  })
})
