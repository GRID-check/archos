/**
 * Which Piloti replies a wake wrote (EU AI Act Art. 50: the thread says who
 * woke Piloti, not only that it spoke).
 *
 * Nothing on a reply says it came from a woken turn, and nothing may be added
 * to the reply row for it: the fact is derived. A woken turn runs in the
 * waking person's own thread of the document, one turn at a time (`if_idle`),
 * and posts its reply as that person's session. So a Piloti reply is a wake's
 * when a wake of the same person on the same mark began before it and had not
 * ended before it. With wakes switched on the browser never asks Piloti itself
 * in a thread, so no other Piloti reply of that person can fall in the window.
 */

import type { AnnotationRecord } from './repository'
import type { AgentWakeTrigger } from './types'
import { listAnsweringWakes, type WakeSpanRow } from './wake-repository'

export type WakeSpan = WakeSpanRow

/** The wake that wrote this reply, or null; the newest of those whose window holds it. Pure. */
export function wakeOfReply(
  reply: { annotationId: string; authorKind: 'person' | 'piloti'; createdBy: string; createdAt: Date | string },
  spans: readonly WakeSpan[]
): AgentWakeTrigger | null {
  if (reply.authorKind !== 'piloti') return null
  const at = new Date(reply.createdAt).getTime()
  const span = spans.find(
    (candidate) =>
      candidate.annotationId === reply.annotationId &&
      candidate.actorUserId === reply.createdBy &&
      candidate.createdAt.getTime() <= at &&
      (candidate.endedAt === null || at <= candidate.endedAt.getTime())
  )
  return span?.triggerKind ?? null
}

/** The wakes the views of these marks need: none, and no query, when no mark carries a Piloti reply. */
export async function wakeSpansFor(
  organizationId: string,
  documentId: string,
  records: ReadonlyArray<Pick<AnnotationRecord, 'replies'>>
): Promise<WakeSpan[]> {
  const anyAgentReply = records.some((record) => record.replies.some((reply) => reply.authorKind === 'piloti'))
  return anyAgentReply ? listAnsweringWakes(organizationId, documentId).catch(() => []) : []
}
