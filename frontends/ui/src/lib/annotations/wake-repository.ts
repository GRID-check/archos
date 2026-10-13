/**
 * The SQL over `piloti_wakes` (migration 0139): the record of each wake of
 * Piloti on an Anmerkung, which the caps count.
 *
 * No authorization here; `./wake.ts` and `./wake-job.ts` own it. Every write
 * that belongs to an event's transaction takes that transaction. A wake is a
 * document fact (`documents/document-visibility.spec.ts`): the reads keyed by
 * a mark or a wake already authorized are listed there, and the project-wide
 * reads („Was Piloti tut") join `documents` behind the reader's predicate.
 */

import 'server-only'
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { documentAnnotations, documents, pilotiWakes, type PilotiWakeRow } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { projectShelfScope, type ProjectDocumentGate } from '@/lib/documents/repository'
import { documentVisibleTo } from '@/lib/documents/visibility'
import type { AnnotationKind, PilotiWakeStatus, PilotiWakeTrigger } from './types'

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
  // A wake held at enqueue never starts, so it is ended as it is recorded
  // (`piloti_wakes_ended_when_final`, 0141).
  const now = new Date()
  const rows = await executor
    .insert(pilotiWakes)
    .values({
      ...wake,
      reason: settled ? (wake.reason ?? 'suppressed') : null,
      settledAt: settled ? now : null,
      endedAt: settled ? now : null,
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
  outcome: { status: 'started' } | { status: 'suppressed' | 'refused' | 'failed'; reason: string }
): Promise<boolean> {
  const db = getDb()
  const reason = 'reason' in outcome ? outcome.reason.slice(0, 500) : null
  const now = new Date()
  const rows = await withTenant({ organizationId }, () =>
    db
      .update(pilotiWakes)
      .set({ status: outcome.status, reason, settledAt: now, endedAt: outcome.status === 'started' ? null : now })
      .where(
        and(eq(pilotiWakes.organizationId, organizationId), eq(pilotiWakes.id, id), eq(pilotiWakes.status, 'queued'))
      )
      .returning({ id: pilotiWakes.id })
  )
  return rows.length > 0
}

/**
 * A wake by its id alone, for the one caller that has no organization yet: the
 * turn's outcome names the turn (the wake's id), and the wake names the
 * organization. Run it under platform access, then do the rest as that tenant.
 */
export async function findWakeById(id: string): Promise<PilotiWakeRow | null> {
  const db = getDb()
  const [row] = await db.select().from(pilotiWakes).where(eq(pilotiWakes.id, id)).limit(1)
  return row ?? null
}

/** The count, read under the tenant scope, for the claim's second look at the caps. */
export async function countWakesInTenant(
  organizationId: string,
  query: Omit<Parameters<typeof countWakes>[1], 'organizationId'>
): Promise<number> {
  const db = getDb()
  return withTenant({ organizationId }, () => countWakes(db, { ...query, organizationId }))
}

/** How a started wake's turn ended (0141). `failed` carries a user-safe reason. */
export type WakeEnd = { status: 'answered' | 'stopped' } | { status: 'failed'; reason: string }

/**
 * Record how a wake's turn ended. From `started`, and also from `queued`: a
 * turn that errors at once can report its end before the job has marked the
 * wake started (the job settles only once the socket acknowledged the turn),
 * and that end must not be lost; the job's later `settleWake(started)` then
 * finds nothing queued and changes nothing. The turn's own outcome, a person's
 * stop and the job's give-up cannot overwrite each other: the first final word
 * stands. The row as ended, or null when it had already ended or is unknown.
 */
export async function endWake(
  executor: DbExecutor,
  organizationId: string,
  id: string,
  end: WakeEnd
): Promise<PilotiWakeRow | null> {
  const reason = end.status === 'failed' ? end.reason.slice(0, 500) : null
  const [row] = await executor
    .update(pilotiWakes)
    .set({ status: end.status, reason, endedAt: new Date(), settledAt: sql`COALESCE(${pilotiWakes.settledAt}, now())` })
    .where(
      and(
        eq(pilotiWakes.organizationId, organizationId),
        eq(pilotiWakes.id, id),
        inArray(pilotiWakes.status, ['queued', 'started'])
      )
    )
    .returning()
  return row ?? null
}

/**
 * The wake of a mark's CURRENT delegation that has not ended yet (`queued` or
 * `started`), newest first, or null. `eventId` is the delegation's event id
 * (`delegationEventId(annotationId, delegatedAt)`), so a wake of an earlier
 * delegation of the same mark is never mistaken for this one.
 */
export async function findLiveDelegationWake(
  executor: DbExecutor,
  organizationId: string,
  annotationId: string,
  eventId: string
): Promise<PilotiWakeRow | null> {
  const [row] = await executor
    .select()
    .from(pilotiWakes)
    .where(
      and(
        eq(pilotiWakes.organizationId, organizationId),
        eq(pilotiWakes.annotationId, annotationId),
        eq(pilotiWakes.triggerKind, 'assigned'),
        eq(pilotiWakes.eventId, eventId),
        inArray(pilotiWakes.status, ['queued', 'started'])
      )
    )
    .orderBy(desc(pilotiWakes.createdAt))
    .limit(1)
  return row ?? null
}

/**
 * Hand a mark back from the delegation that just ended: clear `delegated_by`
 * and `delegated_at` only while the mark is still delegated at `delegatedAt`.
 * A compare-and-swap on that timestamp, so a delegation made in between (the
 * person took it back and delegated again) is never cleared by the end of an
 * earlier one. True when this call cleared it.
 */
export async function handBackDelegation(
  executor: DbExecutor,
  organizationId: string,
  annotationId: string,
  delegatedAt: Date
): Promise<boolean> {
  const rows = await executor
    .update(documentAnnotations)
    .set({ delegatedBy: null, delegatedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(documentAnnotations.organizationId, organizationId),
        eq(documentAnnotations.id, annotationId),
        eq(documentAnnotations.delegatedAt, delegatedAt)
      )
    )
    .returning({ id: documentAnnotations.id })
  return rows.length > 0
}

/** What a wake's turn was, as far as telling its replies from any other Piloti reply needs. */
export interface WakeSpanRow {
  annotationId: string
  actorUserId: string
  triggerKind: PilotiWakeTrigger
  createdAt: Date
  endedAt: Date | null
}

/**
 * The wakes of one document whose turn answered, or is answering: anything
 * that was not held at enqueue (`suppressed`), refused or failed. Newest
 * first. Read by the thread view to mark a Piloti reply that a wake produced.
 */
export async function listAnsweringWakes(organizationId: string, documentId: string): Promise<WakeSpanRow[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        annotationId: pilotiWakes.annotationId,
        actorUserId: pilotiWakes.actorUserId,
        triggerKind: pilotiWakes.triggerKind,
        createdAt: pilotiWakes.createdAt,
        endedAt: pilotiWakes.endedAt,
      })
      .from(pilotiWakes)
      .where(
        and(
          eq(pilotiWakes.organizationId, organizationId),
          eq(pilotiWakes.documentId, documentId),
          inArray(pilotiWakes.status, ['queued', 'started', 'answered', 'stopped'])
        )
      )
      .orderBy(desc(pilotiWakes.createdAt))
      .limit(MAX_WAKE_SPANS)
  )
}

/** A document carries at most this many marks, each with a bounded number of wakes; this only keeps the read bounded. */
const MAX_WAKE_SPANS = 2000

/** A wake as the project's activity lists it: the wake, its mark, and the document's name fields. */
export interface ProjectWakeRow {
  id: string
  status: PilotiWakeStatus
  triggerKind: PilotiWakeTrigger
  eventId: string
  actorUserId: string
  reason: string | null
  createdAt: Date
  settledAt: Date | null
  endedAt: Date | null
  documentId: string
  documentFilename: string
  documentDisplayName: string | null
  annotationId: string
  markNumber: number
  markKind: AnnotationKind
  markBody: string
  markDelegatedAt: Date | null
}

/** The wakes the project's activity can show: not held at enqueue. */
const LIVE_WAKE_STATUSES = ['queued', 'started'] as const
const ENDED_WAKE_STATUSES = ['answered', 'stopped', 'failed', 'refused'] as const

/**
 * The wakes of one project's documents this gate's reader may see, by
 * `where`, newest first by `order`, at most `limit` rows. The mark and the
 * document are joined on the wake's organization; the document behind the
 * gate's project scope and its reader's predicate in THIS query.
 */
async function listProjectWakes(
  gate: ProjectDocumentGate,
  where: SQL,
  order: SQL,
  limit: number
): Promise<ProjectWakeRow[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId: gate.organizationId }, () =>
    db
      .select({
        id: pilotiWakes.id,
        status: pilotiWakes.status,
        triggerKind: pilotiWakes.triggerKind,
        eventId: pilotiWakes.eventId,
        actorUserId: pilotiWakes.actorUserId,
        reason: pilotiWakes.reason,
        createdAt: pilotiWakes.createdAt,
        settledAt: pilotiWakes.settledAt,
        endedAt: pilotiWakes.endedAt,
        documentId: documents.id,
        documentFilename: documents.filename,
        documentDisplayName: documents.displayName,
        annotationId: documentAnnotations.id,
        markNumber: documentAnnotations.number,
        markKind: documentAnnotations.kind,
        markBody: documentAnnotations.body,
        markDelegatedAt: documentAnnotations.delegatedAt,
      })
      .from(pilotiWakes)
      .innerJoin(
        documentAnnotations,
        and(
          eq(documentAnnotations.id, pilotiWakes.annotationId),
          eq(documentAnnotations.organizationId, pilotiWakes.organizationId)
        )
      )
      .innerJoin(
        documents,
        and(eq(documents.id, pilotiWakes.documentId), eq(documents.organizationId, pilotiWakes.organizationId))
      )
      .where(
        and(
          eq(pilotiWakes.organizationId, gate.organizationId),
          where,
          ...projectShelfScope(gate),
          documentVisibleTo(gate.reader)
        )
      )
      .orderBy(order, desc(pilotiWakes.id))
      .limit(limit)
  )
  return rows.map((row) => ({
    ...row,
    createdAt: new Date(row.createdAt),
    settledAt: row.settledAt ? new Date(row.settledAt) : null,
    endedAt: row.endedAt ? new Date(row.endedAt) : null,
    markNumber: Number(row.markNumber),
    markDelegatedAt: row.markDelegatedAt ? new Date(row.markDelegatedAt) : null,
  }))
}

/**
 * The project's wakes whose turn has not ended (`queued`, `started`), newest
 * first by when the event woke Piloti, at most `limit` (a caller that wants
 * to know whether there were more asks for one past its cap). Scans
 * `idx_piloti_wakes_live` (0144).
 */
export function listLiveProjectWakes(gate: ProjectDocumentGate, limit: number): Promise<ProjectWakeRow[]> {
  return listProjectWakes(
    gate,
    inArray(pilotiWakes.status, [...LIVE_WAKE_STATUSES]),
    desc(pilotiWakes.createdAt),
    limit
  )
}

/**
 * The project's wakes that reached their final word at or after `since`
 * (`answered`, `stopped`, `failed`, `refused`; a wake held at enqueue,
 * `suppressed`, ran no turn and is left out), newest first by `ended_at`, at
 * most `limit`. Scans `idx_piloti_wakes_ended` (0144).
 */
export function listEndedProjectWakes(
  gate: ProjectDocumentGate,
  since: Date,
  limit: number
): Promise<ProjectWakeRow[]> {
  return listProjectWakes(
    gate,
    and(
      inArray(pilotiWakes.status, [...ENDED_WAKE_STATUSES]),
      isNotNull(pilotiWakes.endedAt),
      gte(pilotiWakes.endedAt, since)
    ) as SQL,
    desc(pilotiWakes.endedAt),
    limit
  )
}
