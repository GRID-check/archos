/**
 * The ids a wake of Piloti is known by (ADR-0106), derived and never stored
 * anywhere they could disagree.
 *
 * - **The wake, the job and the turn are one id**: uuid5 of the event. A
 *   retry, a double enqueue, and a browser that asked the same question itself
 *   all name the same turn, so the server answers the second one
 *   `duplicate_turn` and Piloti runs once.
 * - **A person's thread about a document** is uuid5 of the document and the
 *   person: the canvas, the chat and the wake job agree on it without a
 *   lookup, and `conversations`' primary key with `ON CONFLICT DO NOTHING` is
 *   the whole of „ensure the thread" (the construction `lib/tasks/task-thread.ts`
 *   uses, ADR-0062).
 *
 * The prefixes are part of the contract: changing one orphans every thread
 * and every wake id already handed out. No `server-only` and no drizzle: the
 * browser derives the turn id of a reply it asks about itself.
 */

import { v5 as uuidv5 } from 'uuid'

/** The wake's id, which is also its `bff_job_queue` job id and the turn id. */
export function wakeTurnId(eventId: string): string {
  return uuidv5(`grid:piloti-wake:${eventId}`, uuidv5.URL)
}

/** The event a delegation to Piloti is: the mark and the moment it was delegated. */
export function delegationEventId(annotationId: string, delegatedAt: Date | string): string {
  const at = typeof delegatedAt === 'string' ? delegatedAt : delegatedAt.toISOString()
  return uuidv5(`grid:annotation-delegation:${annotationId}:${at}`, uuidv5.URL)
}

/**
 * The conversation one person has about one document. The app's conversation
 * id shape: `s_` and a uuid with underscores, because the id doubles as the
 * session's collection name.
 */
export function documentThreadConversationId(documentId: string, userId: string): string {
  return `s_${uuidv5(`grid:document-thread:${documentId}:${userId}`, uuidv5.URL).replace(/-/g, '_')}`
}
