/**
 * The SQL over `piloti_wakes` (migration 0136): the record of each wake of
 * Piloti on an Anmerkung, which the caps count.
 *
 * No authorization here; `./wake.ts` and `./wake-job.ts` own it. Every write
 * that belongs to an event's transaction takes that transaction.
 */

import 'server-only'
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { pilotiWakes, type PilotiWakeRow } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import type { PilotiWakeStatus, PilotiWakeTrigger } from './types'

export interface NewWake {
  id: string
  organizationId: string
  documentId: string
  annotationId: string
  triggerKind: PilotiWakeTrigger
  eventId: string
  actorUserId: string
  /** `queued`, or `suppressed` with its reason when a cap held it at enqueue. */
  status: 'queued' | 'suppressed'
  reason?: string | null
}

/**
 * Record a wake; false when one with this id is already recorded (the same
 * event twice), which is how one event wakes Piloti at most once.
 */
export async function insertWake(executor: DbExecutor, wake: NewWake): Promise<boolean> {
  const settled = wake.status === 'suppressed'
  const rows = await executor
    .insert(pilotiWakes)
    .values({
      ...wake,
      reason: settled ? (wake.reason ?? 'suppressed') : null,
      settledAt: settled ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning({ id: pilotiWakes.id })
  return rows.length > 0
}

/**
 * How many wakes that were let through (anything but `suppressed`) one mark,
 * or one person, had since `since`. `before` narrows it to the wakes recorded
 * ahead of one being claimed, so the claim counts the same window the enqueue
 * did and never itself.
 */
export async function countWakes(
  executor: DbExecutor,
  query: {
    organizationId: string
    since: Date
    annotationId?: string
    actorUserId?: string
    before?: { createdAt: Date; id: string }
  }
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number | string>`count(*)` })
    .from(pilotiWakes)
    .where(
      and(
        eq(pilotiWakes.organizationId, query.organizationId),
        ne(pilotiWakes.status, 'suppressed'),
        gte(pilotiWakes.createdAt, query.since),
        query.annotationId ? eq(pilotiWakes.annotationId, query.annotationId) : undefined,
        query.actorUserId ? eq(pilotiWakes.actorUserId, query.actorUserId) : undefined,
        query.before ? lt(pilotiWakes.createdAt, query.before.createdAt) : undefined,
        query.before ? ne(pilotiWakes.id, query.before.id) : undefined
      )
    )
  return Number(row?.count ?? 0)
}

/** One wake of the organization, or null (gone with its mark). */
export async function findWake(organizationId: string, id: string): Promise<PilotiWakeRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(pilotiWakes)
      .where(and(eq(pilotiWakes.organizationId, organizationId), eq(pilotiWakes.id, id)))
      .limit(1)
  )
  return row ?? null
}

/**
 * Settle a queued wake: it started a turn, or it did not and says why. Only
 * from `queued`, so a second worker that ran the same job cannot rewrite what
 * the first recorded; whether it was this call that settled it.
 */
export async function settleWake(
  organizationId: string,
  id: string,
  outcome: { status: 'started' } | { status: Exclude<PilotiWakeStatus, 'queued' | 'started'>; reason: string }
): Promise<boolean> {
  const db = getDb()
  const reason = 'reason' in outcome ? outcome.reason.slice(0, 500) : null
  const rows = await withTenant({ organizationId }, () =>
    db
      .update(pilotiWakes)
      .set({ status: outcome.status, reason, settledAt: new Date() })
      .where(
        and(eq(pilotiWakes.organizationId, organizationId), eq(pilotiWakes.id, id), eq(pilotiWakes.status, 'queued'))
      )
      .returning({ id: pilotiWakes.id })
  )
  return rows.length > 0
}

/** The count, read under the tenant scope, for the claim's second look at the caps. */
export async function countWakesInTenant(
  organizationId: string,
  query: Omit<Parameters<typeof countWakes>[1], 'organizationId'>
): Promise<number> {
  const db = getDb()
  return withTenant({ organizationId }, () => countWakes(db, { ...query, organizationId }))
}
