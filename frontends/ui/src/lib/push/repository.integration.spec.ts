/**
 * @vitest-environment node
 *
 * Push subscriptions against a REAL Postgres (migration 0147, ADR-0112), through
 * the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/push/repository.integration.spec.ts
 *
 * The unit specs use an in-memory table; these prove the SQL the privacy claims
 * rest on: another organization cannot read, remove or refresh a device; an
 * endpoint belongs to whoever registered it last, across organizations (the
 * one statement that spans tenants, under the audited bypass); the CHECKs
 * refuse what a request could otherwise park in a row.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_push_${Date.now()}`
const OTHER_ORG = `${ORG}_other`
const ANNA = 'user_push_anna'
const BERT = 'user_push_bert'
const CAROL = 'user_push_carol'

describe.skipIf(!url)('push subscriptions against Postgres', () => {
  let repo: typeof import('./repository')
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let db: ReturnType<typeof import('@/lib/db').getDb>

  const as = <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId, userId: null }, run)

  const values = (organizationId: string, userId: string, id: string) => ({
    organizationId,
    userId,
    endpoint: `https://fcm.googleapis.com/fcm/send/${ORG}-${id}`,
    p256dh: 'BPublicKey',
    auth: 'authSecret',
    deviceLabel: 'Chrome auf Windows',
  })

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
  })

  afterAll(async () => {
    await withPlatformAccess('push repository spec cleanup', () =>
      db.execute(sql`DELETE FROM push_subscriptions WHERE organization_id IN (${ORG}, ${OTHER_ORG})`)
    )
  })

  it('writes, lists and removes a device for its own person', async () => {
    const row = await as(ORG, () => repo.upsertSubscription(values(ORG, ANNA, 'a1')))
    expect(row.failureCount).toBe(0)
    expect(row.lastSuccessAt).toBeNull()
    expect((await as(ORG, () => repo.listSubscriptions(ORG, ANNA))).map((r) => r.id)).toContain(row.id)
    expect(await as(ORG, () => repo.listSubscriptions(ORG, BERT))).toEqual([])
    expect(await as(ORG, () => repo.deleteSubscription(ORG, BERT, row.id))).toBe(false)
    expect(await as(ORG, () => repo.deleteSubscription(ORG, ANNA, row.id))).toBe(true)
  })

  it('refreshes the same endpoint instead of duplicating, and resets its failures', async () => {
    const first = await as(ORG, () => repo.upsertSubscription(values(ORG, ANNA, 'refresh')))
    await as(ORG, () => repo.recordFailure(first.id))
    expect(await as(ORG, () => repo.recordFailure(first.id))).toBe(2)
    const again = await as(ORG, () => repo.upsertSubscription({ ...values(ORG, ANNA, 'refresh'), deviceLabel: 'Edge auf Windows' }))
    expect(again.id).toBe(first.id)
    expect(again.failureCount).toBe(0)
    expect(again.deviceLabel).toBe('Edge auf Windows')
    await as(ORG, () => repo.recordDelivered(first.id))
    const [stored] = await as(ORG, () => repo.listSubscriptions(ORG, ANNA))
    expect(stored?.lastSuccessAt).not.toBeNull()
  })

  it('shows another organization nothing and lets it remove nothing', async () => {
    const row = await as(ORG, () => repo.upsertSubscription(values(ORG, ANNA, 'tenant')))
    expect(await as(OTHER_ORG, () => repo.listSubscriptions(ORG, ANNA))).toEqual([])
    expect(await as(OTHER_ORG, () => repo.deleteSubscription(ORG, ANNA, row.id))).toBe(false)
    expect(await as(OTHER_ORG, () => repo.deleteSubscription(OTHER_ORG, ANNA, row.id))).toBe(false)
    expect(await as(OTHER_ORG, () => repo.userIdsWithSubscription(OTHER_ORG, [ANNA]))).toEqual(new Set())
    expect(await as(ORG, () => repo.userIdsWithSubscription(ORG, [ANNA, BERT]))).toEqual(new Set([ANNA]))
  })

  it('cannot be written for an organization other than the active one', async () => {
    await expect(as(OTHER_ORG, () => repo.upsertSubscription(values(ORG, ANNA, 'forged')))).rejects.toThrow()
  })

  it('moves a browser to whoever registered it last, across people and organizations', async () => {
    await as(ORG, () => repo.upsertSubscription(values(ORG, CAROL, 'shared')))
    // Bert, in another office, turns notifications on in the same browser.
    expect(await as(OTHER_ORG, () => repo.claimEndpoint(OTHER_ORG, BERT, values(ORG, CAROL, 'shared').endpoint))).toBe(1)
    await as(OTHER_ORG, () => repo.upsertSubscription(values(OTHER_ORG, BERT, 'shared')))
    expect(await as(ORG, () => repo.userIdsWithSubscription(ORG, [CAROL]))).toEqual(new Set())
    expect(await as(OTHER_ORG, () => repo.userIdsWithSubscription(OTHER_ORG, [BERT]))).toEqual(new Set([BERT]))
    // Claiming one's own endpoint takes nothing.
    expect(await as(OTHER_ORG, () => repo.claimEndpoint(OTHER_ORG, BERT, values(OTHER_ORG, BERT, 'shared').endpoint))).toBe(0)
  })

  it('refuses to take over an endpoint another person still holds when the claim was skipped', async () => {
    await as(ORG, () => repo.upsertSubscription(values(ORG, ANNA, 'no-claim')))
    await expect(as(ORG, () => repo.upsertSubscription(values(ORG, BERT, 'no-claim')))).rejects.toThrow()
    expect(await as(ORG, () => repo.userIdsWithSubscription(ORG, [ANNA]))).toEqual(new Set([ANNA]))
  })

  it('keeps a person’s newest ten devices', async () => {
    const person = 'user_push_many'
    for (let i = 0; i < 12; i += 1) {
      await as(ORG, () => repo.upsertSubscription(values(ORG, person, `many-${i}`)))
    }
    expect(await as(ORG, () => repo.trimSubscriptions(ORG, person))).toBe(2)
    const kept = await as(ORG, () => repo.listSubscriptions(ORG, person))
    expect(kept).toHaveLength(10)
  })

  it('removes every device of a person who left', async () => {
    await as(ORG, () => repo.upsertSubscription(values(ORG, 'user_push_left', 'left-1')))
    await as(ORG, () => repo.upsertSubscription(values(ORG, 'user_push_left', 'left-2')))
    expect(await as(ORG, () => repo.deleteAllSubscriptionsOf(ORG, 'user_push_left'))).toBe(2)
  })

  it('refuses what a request could otherwise park in a row', async () => {
    await expect(
      as(ORG, () => repo.upsertSubscription({ ...values(ORG, ANNA, 'http'), endpoint: 'http://fcm.googleapis.com/x' }))
    ).rejects.toThrow()
    await expect(as(ORG, () => repo.upsertSubscription({ ...values(ORG, ANNA, 'big'), auth: 'x'.repeat(300) }))).rejects.toThrow()
    await expect(as(ORG, () => repo.upsertSubscription({ ...values(ORG, ANNA, 'label'), deviceLabel: '' }))).rejects.toThrow()
  })
})
