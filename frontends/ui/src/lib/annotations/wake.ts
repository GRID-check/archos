/**
 * When an event on an Anmerkung wakes Piloti, and how the wake is enqueued
 * (ADR-0106).
 *
 * A closed list of rules people can read, never a model's guess that a
 * message was meant for it (ADR-0036):
 *
 * | Event | Wakes Piloti when |
 * |---|---|
 * | A person's reply in a mark's thread | it addresses Piloti (the composer's chip), or the mark is Piloti's own `question`, still proposed or open |
 * | A person makes Piloti the delegate on an open mark | always |
 * | A person takes over or dismisses Piloti's mark | never |
 *
 * The wake is enqueued in the SAME transaction as the reply or the
 * delegation (`enqueueWake`), so it exists exactly when the event does. Its
 * id is uuid5 of the event, which is also the job id and the turn id: one
 * event wakes Piloti at most once. It runs as the person whose act is the
 * event (`./wake-job.ts`).
 *
 * The guards: Piloti's own writes never wake it; only a person who may write
 * the document can wake it there (the event's own write already requires
 * that, and the job asks again); a cap per mark per hour and one per person
 * per day, counted at enqueue and again at claim; the person's budget; and
 * the organization's switch, `piloti-wakes`, off by default.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isPilotiWakesEnabled } from '@/lib/authz/feature-flags'
import { recordAuditEvent } from '@/lib/audit/service'
import type { DbTransaction } from '@/lib/db/executor'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, type PilotiWakePayload } from '@/lib/jobs-queue/types'
import { countWakes, insertWake } from './wake-repository'
import {
  isLive,
  type AnnotationAuthor,
  type AnnotationKind,
  type AnnotationStatus,
  type PilotiWakeTrigger,
  type WakeOutcome,
} from './types'
import { wakeTurnId } from './wake-ids'

/** The job kind a wake runs as. */
export const PILOTI_WAKE_JOB = 'piloti_wake'

/** The caps, from `GRID_WAKE_MAX_PER_MARK_HOUR` and `GRID_WAKE_MAX_PER_PERSON_DAY`. */
export interface WakeLimits {
  perMarkHour: number
  perPersonDay: number
}

const DEFAULT_LIMITS: WakeLimits = { perMarkHour: 6, perPersonDay: 50 }

const positive = (raw: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** The caps in force; an unreadable value is the default, `0` lets nothing through. */
export function wakeLimits(env: Record<string, string | undefined> = process.env): WakeLimits {
  return {
    perMarkHour: positive(env.GRID_WAKE_MAX_PER_MARK_HOUR, DEFAULT_LIMITS.perMarkHour),
    perPersonDay: positive(env.GRID_WAKE_MAX_PER_PERSON_DAY, DEFAULT_LIMITS.perPersonDay),
  }
}

/** Whether the organization lets events wake Piloti, as this session carries its flags. */
export function wakesEnabled(session: Pick<AuthorizedSession, 'featureFlags'>): boolean {
  return isPilotiWakesEnabled(session)
}

/**
 * Which trigger a reply is, or null when it wakes nothing. Pure: the rule
 * table above, for a reply.
 */
export function replyTrigger(
  mark: { authorKind: AnnotationAuthor; kind: AnnotationKind; status: AnnotationStatus },
  reply: { authorKind: AnnotationAuthor; addressesPiloti: boolean }
): PilotiWakeTrigger | null {
  // Piloti's own writes never wake it: no Piloti-wakes-Piloti.
  if (reply.authorKind === 'piloti') return null
  if (reply.addressesPiloti) return 'thread_mention'
  if (mark.authorKind === 'piloti' && mark.kind === 'question' && isLive(mark)) return 'thread_reply'
  return null
}

/** The event that wakes Piloti, as the transaction that writes it knows it. */
export interface WakeEvent {
  organizationId: string
  documentId: string
  annotationId: string
  trigger: PilotiWakeTrigger
  /** The reply id, or the delegation's event id. */
  eventId: string
  /** The person whose act it is. */
  actor: { userId: string; email: string | null }
}

/** Why a cap held a wake: the reason recorded on its row. */
export type CapReason = 'cap:mark-hour' | 'cap:person-day'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Which cap, if any, holds a wake: the wakes let through for the mark in the
 * last hour and for the person in the last day. `before` is the wake being
 * claimed, so the claim counts the wakes ahead of it and never itself.
 */
export async function capReached(
  executor: Parameters<typeof countWakes>[0],
  event: Pick<WakeEvent, 'organizationId' | 'annotationId' | 'actor'>,
  now: Date,
  limits: WakeLimits = wakeLimits(),
  before?: { createdAt: Date; id: string }
): Promise<CapReason | null> {
  const perMark = await countWakes(executor, {
    organizationId: event.organizationId,
    annotationId: event.annotationId,
    since: new Date(now.getTime() - HOUR_MS),
    before,
  })
  if (perMark >= limits.perMarkHour) return 'cap:mark-hour'
  const perPerson = await countWakes(executor, {
    organizationId: event.organizationId,
    actorUserId: event.actor.userId,
    since: new Date(now.getTime() - DAY_MS),
    before,
  })
  return perPerson >= limits.perPersonDay ? 'cap:person-day' : null
}

/** What `enqueueWake` did: queued (or already was, for this event), or held by a cap. */
export type EnqueuedWake = { outcome: 'queued'; wakeId: string } | { outcome: 'suppressed'; wakeId: string; reason: CapReason }

/**
 * Record the wake and enqueue its job, in the event's transaction. A cap that
 * holds records the wake as suppressed and enqueues nothing.
 */
export async function enqueueWake(
  tx: DbTransaction,
  event: WakeEvent,
  { now = new Date(), limits = wakeLimits() }: { now?: Date; limits?: WakeLimits } = {}
): Promise<EnqueuedWake> {
  const wakeId = wakeTurnId(event.eventId)
  const row = {
    id: wakeId,
    organizationId: event.organizationId,
    documentId: event.documentId,
    annotationId: event.annotationId,
    triggerKind: event.trigger,
    eventId: event.eventId,
    actorUserId: event.actor.userId,
  }
  const cap = await capReached(tx, event, now, limits)
  if (cap) {
    await insertWake(tx, { ...row, status: 'suppressed', reason: cap })
    return { outcome: 'suppressed', wakeId, reason: cap }
  }
  // Already recorded: the same event, a second time. It is queued (or ran) under this id.
  if (!(await insertWake(tx, { ...row, status: 'queued' }))) return { outcome: 'queued', wakeId }
  const payload: PilotiWakePayload = {
    wakeId,
    trigger: event.trigger,
    eventId: event.eventId,
    documentId: event.documentId,
    annotationId: event.annotationId,
    actor: event.actor,
    waits: 0,
  }
  await enqueueJob(
    {
      kind: PILOTI_WAKE_JOB,
      organizationId: event.organizationId,
      payload: { ...payload },
      // A person is waiting for the answer in the thread: ahead of the
      // lane's bulk walks, never ahead of another organization (the claim is
      // fair across lanes first, ADR-0079).
      priority: BFF_JOB_PRIORITY.interactive,
      jobId: wakeId,
    },
    tx
  )
  return { outcome: 'queued', wakeId }
}

/** The writer's answer for an enqueued (or held) wake. */
export const wakeOutcomeOf = (wake: EnqueuedWake | null): WakeOutcome => (wake ? wake.outcome : 'none')

/**
 * A wake held before Piloti was asked (the person's own act, a rule or a cap,
 * at enqueue or when its job claims it) has no model call and so no trace: it
 * is on its `piloti_wakes` row, and here, in the organization's audit trail,
 * so an admin can see that it was held and why. A wake Piloti was asked and
 * did not answer (the job refused it or gave up, or its turn ended) is
 * `piloti.wake.ended`; one whose turn started is `piloti.wake.started`
 * (`./wake-audit.ts`). Never throws.
 */
export function auditSuppressedWake(input: {
  organizationId: string
  actor: { userId: string; email: string | null }
  annotationId: string
  documentId: string
  trigger: PilotiWakeTrigger
  status: 'suppressed'
  reason: string
  stage: 'enqueue' | 'claim'
}): void {
  void recordAuditEvent({
    action: 'piloti.wake.suppressed',
    organizationId: input.organizationId,
    actor: { userId: input.actor.userId, email: input.actor.email },
    targetType: 'document_annotation',
    targetId: input.annotationId,
    metadata: {
      documentId: input.documentId,
      trigger: input.trigger,
      status: input.status,
      reason: input.reason.slice(0, 200),
      stage: input.stage,
    },
  })
}
