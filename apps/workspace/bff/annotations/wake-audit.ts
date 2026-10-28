/**
 * A wake of Piloti in the organization's audit trail, from the moment its
 * turn starts (`piloti.wake.started`) to how it ended (`piloti.wake.ended`),
 * and a person taking the mark back from under it (`piloti.wake.stopped`).
 * `piloti.wake.ended` is every end of a wake Piloti was asked and did not
 * answer as well: its turn's (`lib/turns/outcome.ts`), and the job's, refused
 * or given up before a turn ran (`./wake-job.ts`). A wake held before it was
 * asked (the person's own act, a rule, a cap) is `piloti.wake.suppressed`
 * (`./wake.ts`). The catalog and the actor model are in
 * `lib/audit/schemas.mjs`.
 *
 * Each is emitted after the write that settles the wake's row committed, by
 * the call whose compare-and-swap won, so a wake is in the trail once per
 * step however often its job or its outcome is delivered. Ids, the trigger,
 * the mark's number and the outcome only: never what anyone wrote.
 *
 * The wake's row keeps the person's id, not their email, so an actor without
 * one is looked up in the organization's directory before the event goes out
 * (best effort: the id alone when the directory does not know them). The act
 * never waits for it.
 */

import 'server-only'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuditEventInput } from '@/lib/audit/service'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { AgentWakeTrigger } from './types'
import { wakeEndReasonKind } from './wake-end-reason'
import { documentThreadConversationId } from './wake-ids'

/** A person as the trail names them. */
interface AuditPerson {
  userId: string
  email: string | null
}

/** The person with their email: the caller's, else the directory's, else none. Never rejects. */
async function withEmail(organizationId: string, person: AuditPerson): Promise<AuditPerson> {
  if (person.email) return person
  try {
    const directory = await loadOrganizationDirectory(organizationId)
    return { userId: person.userId, email: directory.get(person.userId)?.email ?? null }
  } catch {
    return { userId: person.userId, email: null }
  }
}

/** Record the event as its actor, their email looked up first when the caller had none. Never throws, never waits. */
function recordAsPerson(input: AuditEventInput & { actor: AuditPerson }): void {
  if (input.actor.email) {
    recordAuditEventAfterCommit(input)
    return
  }
  void withEmail(input.organizationId, input.actor).then((actor) => recordAuditEventAfterCommit({ ...input, actor }))
}

/** One wake, as the trail names it. */
export interface AuditedWake {
  organizationId: string
  wakeId: string
  documentId: string
  annotationId: string
  trigger: AgentWakeTrigger
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
  recordAsPerson({
    action: 'piloti.wake.started',
    organizationId: wake.organizationId,
    actor: wake.wokenBy,
    ...wakeTargets(wake),
    metadata: { trigger: wake.trigger, wakeId: wake.wakeId, markNumber: wake.markNumber, waits },
  })
}

/**
 * How the wake ended: its turn answered, was stopped or failed (the turn's own
 * words for why), or the job refused it or gave up before a turn answered.
 */
export interface AuditedWakeEnd {
  outcome: 'answered' | 'stopped' | 'failed' | 'refused'
  /**
   * What the chat socket reported at the turn's end: answered, handed_off,
   * stopped, refused, failed. Null when the job ended the wake, without a turn.
   */
  turnOutcome: string | null
  reason: string | null
  /** The delegation ended with the wake, and the mark went back to the person. */
  handedBack: boolean
}

/** Cut, like `piloti.wake.suppressed`: a reason is a sentence, not a log. */
const REASON_MAX = 200

/**
 * The wake ended, and this call recorded it. `reasonKind` is the class the
 * inbox words its notice by (`./wake-end-reason.ts`: budget, busy, access,
 * error), so the trail and the person's notice say the same why. Never throws.
 */
export function auditWakeEnded(wake: AuditedWake, end: AuditedWakeEnd): void {
  recordAsPerson({
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
      reasonKind: wakeEndReasonKind(end.outcome, end.reason),
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
  recordAsPerson({
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
