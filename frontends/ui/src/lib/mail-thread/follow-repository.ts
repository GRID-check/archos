import 'server-only'
/**
 * SQL of „Verlauf folgen“ (ADR-0137, DECISION D31): a person's follow of one
 * E-Mail-Verlauf, started, renewed and ended, and the one transaction in which
 * the follow job turns a reply's text into the follower's decision. No
 * authorization here: `./follows.ts` and `lib/inbound-mail/follow-job.ts`
 * decide who may, and row-level security is the backstop.
 *
 * The rules the rows keep are the migration's (0186): one running follow per
 * person and thread (`uniq_mail_thread_follows_active`), at most 180 days from
 * its start, an end always with its reason and, for a person's reason, the
 * right person; a follow decision is the follower's own (the composite key to
 * `mail_thread_follows`) and appends text only. Every write here is a
 * compare-and-set on `ended_at IS NULL`, so two hands ending one follow end it
 * once, and the second learns it.
 */

import { and, count, eq, gt, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  documents,
  inboundMailDecisions,
  inboundMailParts,
  inboundMails,
  mailThreadFollows,
  mailThreads,
  projectFolders,
  type InboundMailDecisionRow,
  type MailThreadFollowRow,
  type NewInboundMailDecisionRow,
  type NewMailThreadFollowRow,
} from '@/lib/db/schema'
import type { DocumentReader } from '@/lib/documents/document-reader'
import { documentVisibleTo } from '@/lib/documents/visibility'
import {
  MAIL_THREAD_FOLLOW_MAX_DAYS,
  MAIL_THREAD_FOLLOW_PROJECT_DAILY_CAP,
  type MailThreadFollowEndReason,
} from './mail-thread-vocabulary'

const DAY_MS = 24 * 60 * 60 * 1000

/** The follow a person runs on a thread, run out or not; null when none is running. */
export async function findRunningFollow(threadId: string, userId: string): Promise<MailThreadFollowRow | null> {
  const [row] = await getDb()
    .select()
    .from(mailThreadFollows)
    .where(
      and(
        eq(mailThreadFollows.threadId, threadId),
        eq(mailThreadFollows.userId, userId),
        isNull(mailThreadFollows.endedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

/** One follow by id in the project, whatever its state. */
export async function findFollow(projectId: string, followId: string): Promise<MailThreadFollowRow | null> {
  const [row] = await getDb()
    .select()
    .from(mailThreadFollows)
    .where(and(eq(mailThreadFollows.projectId, projectId), eq(mailThreadFollows.id, followId)))
    .limit(1)
  return row ?? null
}

/**
 * Start a follow. Null when the person already runs one on the thread (the
 * partial unique index answered first): the caller renews that one instead.
 */
export async function startFollow(row: NewMailThreadFollowRow): Promise<MailThreadFollowRow | null> {
  const [inserted] = await getDb().insert(mailThreadFollows).values(row).onConflictDoNothing().returning()
  return inserted ?? null
}

/**
 * Renew a running follow to `until`, never past 180 days from its start (the
 * migration's window; after that the person follows again, which is a new
 * decision). The day-55 notice is owed again. Null when it ended meanwhile.
 */
export async function renewFollow(followId: string, until: Date, now: Date): Promise<MailThreadFollowRow | null> {
  const [renewed] = await getDb()
    .update(mailThreadFollows)
    .set({
      expiresAt: sql`LEAST(${until.toISOString()}::timestamptz, ${mailThreadFollows.createdAt} + make_interval(days => ${MAIL_THREAD_FOLLOW_MAX_DAYS}))`,
      renewedAt: now,
      expiringNotifiedAt: null,
    })
    .where(and(eq(mailThreadFollows.id, followId), isNull(mailThreadFollows.endedAt)))
    .returning()
  return renewed ?? null
}

/** How a follow ends: the reason, and the person who ended it (null when the system noticed). */
export interface FollowEnd {
  reason: MailThreadFollowEndReason
  endedBy: string | null
}

/** End a running follow. Null when it had ended already: ending twice changes nothing. */
export async function endFollow(followId: string, end: FollowEnd, now: Date = new Date()): Promise<MailThreadFollowRow | null> {
  const [ended] = await getDb()
    .update(mailThreadFollows)
    .set({ endedAt: now, endedBy: end.endedBy, endedReason: end.reason })
    .where(and(eq(mailThreadFollows.id, followId), isNull(mailThreadFollows.endedAt)))
    .returning()
  return ended ?? null
}

/**
 * Where a thread's document stands for a reader: `live` (there, active, not in
 * a binned folder), `gone` (deleted, archived, or in the bin: the follows of
 * the thread end, D31), or `unseen` (there, but held from this reader by its
 * screening, which may still pass).
 */
export type ThreadDocumentState = 'live' | 'gone' | 'unseen'

export async function findThreadDocumentState(
  projectId: string,
  threadId: string,
  reader: DocumentReader,
): Promise<ThreadDocumentState> {
  const db = getDb()
  const [thread] = await db
    .select({ documentId: mailThreads.documentId })
    .from(mailThreads)
    .where(and(eq(mailThreads.projectId, projectId), eq(mailThreads.id, threadId)))
    .limit(1)
  if (!thread?.documentId) return 'gone'
  const [document] = await db
    .select({ lifecycle: documents.lifecycle, folderBinnedAt: projectFolders.deletedAt })
    .from(documents)
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .where(and(eq(documents.id, thread.documentId), eq(documents.projectId, projectId), documentVisibleTo(reader)))
    .limit(1)
  if (!document) return 'unseen'
  return document.lifecycle === 'active' && document.folderBinnedAt === null ? 'live' : 'gone'
}

/** What the follow job asks the transaction to write: the follower's decision about a reply's text. */
export interface FollowDecisionInput {
  follow: { id: string; userId: string; threadId: string }
  mail: { id: string; organizationId: string; projectId: string; receivedAt: Date }
  partId: string
  /** The decision row, less what the transaction fixes (who, how, which follow). */
  decision: Pick<NewInboundMailDecisionRow, 'id' | 'messageText' | 'documentType'>
  claimExpiresAt: Date
  now: Date
}

/**
 * What the transaction did. Anything but `written` leaves the mail exactly as
 * it was: it waits for a person.
 */
export type FollowDecisionWrite =
  | { kind: 'written'; decision: InboundMailDecisionRow }
  /** The follow ended, ran out, or is younger than the mail (D31 condition 1). */
  | { kind: 'follow_not_running' }
  /** The follow made its `daily_cap` appends in the last day (condition 8). */
  | { kind: 'follow_cap' }
  /** The project's follows made {@link MAIL_THREAD_FOLLOW_PROJECT_DAILY_CAP} appends in the last day (condition 8). */
  | { kind: 'project_cap' }
  /** The mail is no longer waiting, or its text is no longer: a person decided first. */
  | { kind: 'not_waiting' }

/** Thrown inside the transaction to roll it back with an answer. */
class FollowDecisionRefused extends Error {
  constructor(readonly outcome: Exclude<FollowDecisionWrite, { kind: 'written' }>) {
    super(outcome.kind)
  }
}

/**
 * The follower's decision about a reply's text, all or nothing (D31, DECISION
 * §6 "Follow" step 3):
 *
 * 1. Lock the follow and require it running, made before the mail arrived.
 * 2. Lock the mail and require it waiting.
 * 3. Under the project's lock, count the appends of the last day: the
 *    follow's own against its `daily_cap`, the project's against
 *    {@link MAIL_THREAD_FOLLOW_PROJECT_DAILY_CAP}. Two follow jobs of one
 *    project count one after the other, so neither cap is passed by a race.
 * 4. Insert the decision (`via = 'follow'`, as the follower, `append` to the
 *    follow's thread) and claim the text part `waiting → filing` with it.
 *
 * The database refuses the rest: a decision by anyone but the follower, on
 * another thread, or one that acknowledges or releases anything.
 */
export async function writeFollowDecision(input: FollowDecisionInput): Promise<FollowDecisionWrite> {
  const { follow, mail, now } = input
  const since = new Date(now.getTime() - DAY_MS)
  try {
    return await getDb().transaction(async (tx) => {
      const [running] = await tx
        .select()
        .from(mailThreadFollows)
        .where(eq(mailThreadFollows.id, follow.id))
        .for('update')
        .limit(1)
      if (
        !running ||
        running.endedAt !== null ||
        running.threadId !== follow.threadId ||
        running.userId !== follow.userId ||
        new Date(running.expiresAt).getTime() <= now.getTime() ||
        new Date(running.createdAt).getTime() >= mail.receivedAt.getTime()
      )
        throw new FollowDecisionRefused({ kind: 'follow_not_running' })

      const [held] = await tx
        .select({ status: inboundMails.status })
        .from(inboundMails)
        .where(eq(inboundMails.id, mail.id))
        .for('update')
        .limit(1)
      if (held?.status !== 'waiting') throw new FollowDecisionRefused({ kind: 'not_waiting' })

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inbound_mail_follow:${mail.projectId}`}, 0))`,
      )
      const [own] = await tx
        .select({ appended: count() })
        .from(inboundMailDecisions)
        .where(and(eq(inboundMailDecisions.followId, follow.id), gt(inboundMailDecisions.decidedAt, since)))
      if (Number(own?.appended ?? 0) >= running.dailyCap) throw new FollowDecisionRefused({ kind: 'follow_cap' })
      const [project] = await tx
        .select({ appended: count() })
        .from(inboundMailDecisions)
        .where(
          and(
            eq(inboundMailDecisions.projectId, mail.projectId),
            eq(inboundMailDecisions.via, 'follow'),
            gt(inboundMailDecisions.decidedAt, since),
          ),
        )
      if (Number(project?.appended ?? 0) >= MAIL_THREAD_FOLLOW_PROJECT_DAILY_CAP)
        throw new FollowDecisionRefused({ kind: 'project_cap' })

      const [decision] = await tx
        .insert(inboundMailDecisions)
        .values({
          ...input.decision,
          organizationId: mail.organizationId,
          projectId: mail.projectId,
          mailId: mail.id,
          partId: input.partId,
          action: 'file',
          decidedBy: follow.userId,
          via: 'follow',
          followId: follow.id,
          threadAction: 'append',
          mailThreadId: follow.threadId,
          decidedAt: now,
        })
        .returning()
      if (!decision) throw new Error(`the follow decision about part ${input.partId} was not written`)
      const claimed = await tx
        .update(inboundMailParts)
        .set({
          state: 'filing',
          decisionId: decision.id,
          claimExpiresAt: input.claimExpiresAt,
          lastFailure: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(inboundMailParts.id, input.partId),
            eq(inboundMailParts.mailId, mail.id),
            eq(inboundMailParts.kind, 'message'),
            eq(inboundMailParts.state, 'waiting'),
          ),
        )
        .returning({ id: inboundMailParts.id })
      if (claimed.length !== 1) throw new FollowDecisionRefused({ kind: 'not_waiting' })
      await tx.update(inboundMails).set({ updatedAt: now }).where(eq(inboundMails.id, mail.id))
      return { kind: 'written' as const, decision }
    })
  } catch (error) {
    if (error instanceof FollowDecisionRefused) return error.outcome
    throw error
  }
}
