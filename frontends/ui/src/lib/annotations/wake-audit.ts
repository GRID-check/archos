/**
 * A wake of Piloti in the organization's audit trail, from the moment its
 * turn starts (`piloti.wake.started`) to how it ended (`piloti.wake.ended`),
 * and a person taking the mark back from under it (`piloti.wake.stopped`). A
 * wake that started no turn is `piloti.wake.suppressed` (`./wake.ts`). The
 * catalog and the actor model are in `lib/audit/schemas.mjs`.
 *
 * Each is emitted after the write that settles the wake's row committed, by
 * the call whose compare-and-swap won, so a wake is in the trail once per
 * step however often its job or its outcome is delivered. Ids, the trigger,
 * the mark's number and the outcome only: never what anyone wrote.
 */

import 'server-only'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { PilotiWakeTrigger } from './types'
import { documentThreadConversationId } from './wake-ids'

/** One wake, as the trail names it. */
export interface AuditedWake {
  organizationId: string
  wakeId: string
  documentId: string
  annotationId: string
  trigger: PilotiWakeTrigger
  /** The person whose act woke Piloti: the turn runs as them, in their thread about the document. */
  wokenBy: { userId: string; email: string | null }
  projectId: string | null
  markNumber: number | null
}

/** The mark, then its document, its project and the thread the turn runs in. */
const wakeTargets = (wake: AuditedWake) => ({
  targetType: 'document_annotation',
  targetId: wake.annotationId,
  alsoTargets: [
    { type: 'document', id: wake.documentId },
    { type: 'project', id: wake.projectId },
    {
      type: 'conversation',
      id: documentThreadConversationId(wake.documentId, wake.wokenBy.userId),
    },
  ],
})

/** The socket took the wake's turn. Never throws. */
export function auditWakeStarted(wake: AuditedWake, waits: number): void {
  recordAuditEventAfterCommit({
    action: 'piloti.wake.started',
    organizationId: wake.organizationId,
    actor: wake.wokenBy,
    ...wakeTargets(wake),
    metadata: { trigger: wake.trigger, wakeId: wake.wakeId, markNumber: wake.markNumber, waits },
  })
}

/** How the wake's turn ended: answered, stopped, or failed with the turn's own words for why. */
export interface AuditedWakeEnd {
  outcome: 'answered' | 'stopped' | 'failed'
  /** What the chat socket reported: answered, handed_off, stopped, refused, failed. */
  turnOutcome: string
  reason: string | null
  /** The delegation ended with the turn, and the mark went back to the person. */
  handedBack: boolean
}

/** Cut, like `piloti.wake.suppressed`: a reason is a sentence, not a log. */
const REASON_MAX = 200

/** The turn ended, and this call recorded it. Never throws. */
export function auditWakeEnded(wake: AuditedWake, end: AuditedWakeEnd): void {
  recordAuditEventAfterCommit({
    action: 'piloti.wake.ended',
    organizationId: wake.organizationId,
    actor: wake.wokenBy,
    ...wakeTargets(wake),
    metadata: {
      trigger: wake.trigger,
      wakeId: wake.wakeId,
      outcome: end.outcome,
      turnOutcome: end.turnOutcome,
      reason: end.reason?.trim().slice(0, REASON_MAX) || null,
      handedBack: end.handedBack,
      markNumber: wake.markNumber,
    },
  })
}

/** Who took the mark back. */
export interface WakeStopper {
  userId: string
  email: string | null
  /** Piloti closed the mark in this person's name. */
  piloti: boolean
}

/**
 * A take-back stopped the wake: one still `queued` will start no turn, one
 * `started` has its turn stopped (it then ends `stopped`). Never throws.
 */
export function auditWakeStopped(
  wake: AuditedWake,
  wakeStatus: 'queued' | 'started',
  by: WakeStopper
): void {
  recordAuditEventAfterCommit({
    action: 'piloti.wake.stopped',
    organizationId: wake.organizationId,
    actor: { userId: by.userId, email: by.email },
    ...wakeTargets(wake),
    metadata: {
      trigger: wake.trigger,
      wakeId: wake.wakeId,
      wakeStatus,
      wokenBy: wake.wokenBy.userId,
      by: by.piloti ? 'piloti' : 'person',
    },
  })
}
