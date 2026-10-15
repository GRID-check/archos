/**
 * The only module that queries `push_subscriptions` (ADR-0017, ADR-0112).
 *
 * Every function but {@link claimEndpoint} runs in the caller's tenant scope and
 * names the organization and the person in its WHERE, so the policy is the
 * backstop rather than the plan. Every list is bounded: a person holds a handful
 * of devices, and {@link MAX_DEVICES_PER_PERSON} is the most the service keeps.
 */

import 'server-only'
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { pushSubscriptions, type PushSubscriptionRow } from '@/lib/db/schema'
import { withPlatformAccess } from '@/lib/db/tenant-context'

/** The most devices one person keeps; registering past it drops the oldest. */
export const MAX_DEVICES_PER_PERSON = 10

export interface SubscriptionValues {
  organizationId: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  deviceLabel: string
}

/**
 * Remove the rows another person, or the same person in another organization,
 * holds for this endpoint, so the endpoint can belong to the caller.
 *
 * An endpoint is one browser installation. When B signs in on A's computer and
 * turns notifications on, A's row for that browser must go, or A's inbox keeps
 * arriving on B's screen. The statement spans tenants by nature (the row it
 * removes is in a tenant the caller is not in), so it runs under the audited
 * bypass with its reason, and it removes nothing the caller owns.
 */
export async function claimEndpoint(
  organizationId: string,
  userId: string,
  endpoint: string
): Promise<number> {
  const rows = await withPlatformAccess(
    'a device registered by a new person: removing the previous holder of the same browser endpoint',
    () =>
      getDb()
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.endpoint, endpoint),
            sql`NOT (${pushSubscriptions.organizationId} = ${organizationId} AND ${pushSubscriptions.userId} = ${userId})`
          )
        )
        .returning({ id: pushSubscriptions.id })
  )
  return rows.length
}

/**
 * Write the device, or refresh it when this person already registered the
 * endpoint (the browser re-sends it on every start). A refresh resets the
 * failure count: the browser has just shown the subscription is alive.
 */
export async function upsertSubscription(values: SubscriptionValues): Promise<PushSubscriptionRow> {
  const [row] = await getDb()
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        p256dh: values.p256dh,
        auth: values.auth,
        deviceLabel: values.deviceLabel,
        failureCount: 0,
      },
      // Belt: `claimEndpoint` ran first, so a conflict here is this person's own
      // row. If a race put someone else's there, the update matches nothing and
      // the insert reports it rather than taking the device over.
      setWhere: and(
        eq(pushSubscriptions.organizationId, values.organizationId),
        eq(pushSubscriptions.userId, values.userId)
      ),
    })
    .returning()
  if (!row) throw new Error('push subscription could not be written: the endpoint belongs to another person')
  return row
}

/** A person's devices, newest first. */
export async function listSubscriptions(organizationId: string, userId: string): Promise<PushSubscriptionRow[]> {
  return getDb()
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.organizationId, organizationId), eq(pushSubscriptions.userId, userId)))
    .orderBy(desc(pushSubscriptions.createdAt))
    .limit(MAX_DEVICES_PER_PERSON + 1)
}

/** Remove one of the person's devices; whether it was theirs and there. */
export async function deleteSubscription(organizationId: string, userId: string, id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.id, id),
        eq(pushSubscriptions.organizationId, organizationId),
        eq(pushSubscriptions.userId, userId)
      )
    )
    .returning({ id: pushSubscriptions.id })
  return rows.length > 0
}

/** Remove the person's device registered under this endpoint (the one a rotation replaces). */
export async function deleteSubscriptionByEndpoint(
  organizationId: string,
  userId: string,
  endpoint: string
): Promise<boolean> {
  const rows = await getDb()
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, endpoint),
        eq(pushSubscriptions.organizationId, organizationId),
        eq(pushSubscriptions.userId, userId)
      )
    )
    .returning({ id: pushSubscriptions.id })
  return rows.length > 0
}

/** Remove every device of a person in the organization (they left it). */
export async function deleteAllSubscriptionsOf(organizationId: string, userId: string): Promise<number> {
  const rows = await getDb()
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.organizationId, organizationId), eq(pushSubscriptions.userId, userId)))
    .returning({ id: pushSubscriptions.id })
  return rows.length
}

/** Keep the person's newest {@link MAX_DEVICES_PER_PERSON} devices; how many were dropped. */
export async function trimSubscriptions(organizationId: string, userId: string): Promise<number> {
  const db = getDb()
  const keep = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.organizationId, organizationId), eq(pushSubscriptions.userId, userId)))
    .orderBy(desc(pushSubscriptions.createdAt))
    .limit(MAX_DEVICES_PER_PERSON)
  if (keep.length < MAX_DEVICES_PER_PERSON) return 0
  const dropped = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.organizationId, organizationId),
        eq(pushSubscriptions.userId, userId),
        notInArray(
          pushSubscriptions.id,
          keep.map((row) => row.id)
        )
      )
    )
    .returning({ id: pushSubscriptions.id })
  return dropped.length
}

/**
 * Which of these people hold at least one device: one indexed read, so an inbox
 * write for a person without any costs nothing more.
 */
export async function userIdsWithSubscription(
  organizationId: string,
  userIds: readonly string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const rows = await getDb()
    .selectDistinct({ userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(
      and(eq(pushSubscriptions.organizationId, organizationId), inArray(pushSubscriptions.userId, [...userIds]))
    )
  return new Set(rows.map((row) => row.userId))
}

/** The push service accepted a message for this device. */
export async function recordDelivered(id: string): Promise<void> {
  await getDb()
    .update(pushSubscriptions)
    .set({ lastSuccessAt: new Date(), failureCount: 0 })
    .where(eq(pushSubscriptions.id, id))
}

/** A send failed in a way that may heal; the new count, or null when the row is gone. */
export async function recordFailure(id: string): Promise<number | null> {
  const [row] = await getDb()
    .update(pushSubscriptions)
    .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
    .where(eq(pushSubscriptions.id, id))
    .returning({ failureCount: pushSubscriptions.failureCount })
  return row?.failureCount ?? null
}

/** Remove a device by id: the push service said it is gone. */
export async function deleteSubscriptionById(id: string): Promise<void> {
  await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.id, id))
}
