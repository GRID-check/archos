import 'server-only'
/**
 * „Verlauf folgen“: a person's standing decision about one E-Mail-Verlauf
 * (ADR-0137, DECISION D31). While it runs, a later reply's TEXT is appended to
 * the thread as that person, by the follow job and only when every one of
 * D31's nine conditions holds (`lib/inbound-mail/follow-job.ts`); attachments
 * always wait for a person. This module is the decision itself:
 *
 * - **Following** (`mail-thread-follow`) is the person's own act, so the
 *   operation is `control`-sensitive: Piloti never sees it, an outside agent
 *   only under the office's opt-in and the step-up scope. Who may: whoever may
 *   file mail into the project (the `inbound-mail` entitlement,
 *   `project:documents:write`, an open project) and read and write the thread
 *   document's folder, the rights an append is filed with. Calling it again
 *   renews the running follow; a follow runs at most 180 days from its start
 *   (the migration's window), after which the person follows again.
 * - **Ending** (`mail-thread-unfollow`) is the follower's, or anyone's who
 *   manages the project (`project:manage`, an org admin through the usual
 *   bypass). It is possible in a closed project and needs only `project:view`:
 *   a person who lost the right to file can still stop a standing decision of
 *   theirs. Ending what is not running changes nothing.
 * - **The system ends a follow** when the follow job finds the follower's
 *   access gone or the thread's document gone ({@link endFollowBySystem}).
 *   Expiry is sweep 12's; an address change and a detach end the follows they
 *   affect in their own transactions; closing the project ends every follow
 *   on it ({@link endFollowsOnProjectClose}).
 *
 * Every start, renewal and end is a line in the audit trail
 * (`mail_thread.follow_started`, `mail_thread.follow_ended`) and a PostHog
 * `mail_thread_followed` event with ids and codes only.
 */

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { captureServer } from '@/lib/analytics/posthog-server'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import { SYSTEM_ACTORS } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds, requireFolderWrite } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import type { MailThreadFollowRow } from '@/lib/db/schema'
import { memberReader } from '@/lib/documents/document-reader'
import { managesProject, requireInboundMailEnabled, requireMailReviewer } from '@/lib/inbound-mail/access'
import { settleFollowExpiring } from '@/lib/inbound-mail/announce'
import { auditFollowsEnded } from '@/lib/inbound-mail/audit'
import { endProjectFollows } from '@/lib/inbound-mail/repository'
import { publishProjectChanged } from '@/lib/realtime/door-events'
import { endFollow, findRunningFollow, renewFollow, startFollow, type FollowEnd } from './follow-repository'
import type {
  MailThreadFollowBody,
  MailThreadFollowResultView,
  MailThreadFollowView,
  MailThreadUnfollowQuery,
  MailThreadUnfollowResultView,
} from './mail-thread-wire'
import { MAIL_THREAD_FOLLOW_DEFAULT_DAYS } from './mail-thread-vocabulary'
import { findVisibleThread } from './repository'
import { findWritableThread } from './write-repository'

const DAY_MS = 24 * 60 * 60 * 1000

/** A follow as the routes answer it. */
export function followView(follow: MailThreadFollowRow): MailThreadFollowView {
  return {
    id: follow.id,
    userId: follow.userId,
    createdAt: new Date(follow.createdAt).toISOString(),
    expiresAt: new Date(follow.expiresAt).toISOString(),
    renewedAt: follow.renewedAt === null ? null : new Date(follow.renewedAt).toISOString(),
    dailyCap: follow.dailyCap,
  }
}

const notFound = () => new NotFoundError('Mail thread not found')

/**
 * Follow the thread, or renew the follow the caller runs on it, for `days`
 * (default 60). See the module header for who may.
 */
export async function followMailThread(
  session: AuthorizedSession,
  projectId: string,
  threadId: string,
  body: MailThreadFollowBody,
): Promise<MailThreadFollowResultView> {
  await requireMailReviewer(session, projectId)
  const hidden = await getHiddenFolderIds(session, projectId)
  if (!(await findVisibleThread(projectId, threadId, hidden))) throw notFound()
  const thread = await findWritableThread(projectId, threadId, memberReader(session.userId))
  if (!thread) throw notFound()
  // The rights every append is filed with: write in an open project, and in the document's folder.
  await requireFolderWrite(session, projectId, [thread.document.folderId])

  const days = body.days ?? MAIL_THREAD_FOLLOW_DEFAULT_DAYS
  const now = new Date()
  const until = new Date(now.getTime() + days * DAY_MS)
  const { follow, renewed } = await startOrRenew(session, projectId, threadId, until, now)

  recordFollowStarted(session, follow, { days, renewed })
  publishProjectChanged(session.organizationId, projectId)
  return { follow: followView(follow), renewed }
}

/** The running follow renewed, or a new one: a follow that ran out but was not swept yet is ended first. */
async function startOrRenew(
  session: AuthorizedSession,
  projectId: string,
  threadId: string,
  until: Date,
  now: Date,
): Promise<{ follow: MailThreadFollowRow; renewed: boolean }> {
  // Twice at most: a follow another request started between the read and the insert is renewed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const running = await findRunningFollow(threadId, session.userId)
    if (running && new Date(running.expiresAt).getTime() > now.getTime()) {
      const follow = await renewFollow(running.id, until, now)
      if (!follow) continue
      // Renewed: a renewal asked for on day 55 is answered (sweep 12 asks again before the new end).
      await settleFollowExpiring(session.organizationId, [follow.id])
      return { follow, renewed: true }
    }
    if (running) await endFollowBySystem(running, 'expired', now)
    const follow = await startFollow({
      organizationId: session.organizationId,
      projectId,
      threadId,
      userId: session.userId,
      createdAt: now,
      expiresAt: until,
    })
    if (follow) return { follow, renewed: false }
  }
  throw new Error(`could not start or renew the follow of mail thread ${threadId}`)
}

/**
 * End the caller's follow of the thread, or, for `project:manage`, someone
 * else's (`userId`). See the module header for who may.
 */
export async function unfollowMailThread(
  session: AuthorizedSession,
  projectId: string,
  threadId: string,
  query: MailThreadUnfollowQuery,
): Promise<MailThreadUnfollowResultView> {
  requireInboundMailEnabled(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const followerId = query.userId ?? session.userId
  const own = followerId === session.userId
  if (!own && !(await managesProject(session, projectId))) {
    throw new ForbiddenError("Ending another person's follow needs project:manage")
  }

  const running = await findRunningFollow(threadId, followerId)
  if (!running || running.projectId !== projectId) {
    // Nothing to end. Answered only for a thread the caller may read, so the
    // answer tells nobody that a thread they may not see exists.
    if (!(await findVisibleThread(projectId, threadId, await getHiddenFolderIds(session, projectId)))) throw notFound()
    return { endedFollowId: null }
  }
  const end: FollowEnd = own
    ? { reason: 'unfollowed', endedBy: session.userId }
    : { reason: 'revoked_by_manager', endedBy: session.userId }
  const ended = await endFollow(running.id, end)
  if (!ended) return { endedFollowId: null }
  recordFollowEnded(session.organizationId, { userId: session.userId, email: session.email || null }, ended)
  await settleFollowExpiring(session.organizationId, [ended.id])
  publishProjectChanged(session.organizationId, projectId)
  return { endedFollowId: ended.id }
}

/**
 * End a follow because the system noticed (the follow job: the follower's
 * access or the thread's document is gone; a renewal: it ran out; sweep 12:
 * it ran out, its document is gone, or its project was closed and the close
 * did not end it). Whether this call ended it.
 */
export async function endFollowBySystem(
  follow: Pick<MailThreadFollowRow, 'id'>,
  reason: Extract<FollowEnd['reason'], 'access_lost' | 'document_gone' | 'expired' | 'project_closed'>,
  now: Date = new Date(),
): Promise<boolean> {
  const ended = await endFollow(follow.id, { reason, endedBy: null }, now)
  if (!ended) return false
  recordFollowEnded(ended.organizationId, { userId: SYSTEM_ACTORS.inboundMail, email: null }, ended)
  await settleFollowExpiring(ended.organizationId, [ended.id])
  publishProjectChanged(ended.organizationId, ended.projectId)
  return true
}

/**
 * Closing a project ends every running follow on it (`project_closed`, the
 * coordinator's decision of 2026-10-27): a follow is a standing decision to
 * file replies, and it ends with the work. Mail that still arrives waits in
 * the closed project for a person, as it always did (D10); only the standing
 * decision goes. Ended as the person who closed it, each with its audit line,
 * its PostHog end and its renewal request settled. Reopening the project
 * starts no follow again: following is the follower's own act.
 *
 * Called after the close committed; the caller treats a failure as a log
 * line, and sweep 12 ends what this missed (`findEndingFollows`).
 */
export async function endFollowsOnProjectClose(session: AuthorizedSession, projectId: string, at: Date = new Date()): Promise<number> {
  const ended = await endProjectFollows(getDb(), projectId, { endedBy: session.userId, reason: 'project_closed' }, at)
  if (ended.length === 0) return 0
  auditFollowsEnded(session.organizationId, projectId, session.userId, ended, 'project_closed')
  // One end per follow, as every other end is counted.
  ended.forEach(() =>
    captureServer({
      event: 'mail_thread_followed',
      distinctId: session.userId,
      organizationId: session.organizationId,
      properties: { action: 'end', reason: 'project_closed' },
    })
  )
  await settleFollowExpiring(session.organizationId, ended.map((follow) => follow.id))
  publishProjectChanged(session.organizationId, projectId)
  return ended.length
}

function recordFollowStarted(
  session: AuthorizedSession,
  follow: MailThreadFollowRow,
  started: { days: number; renewed: boolean },
): void {
  recordAuditEventAfterCommit({
    action: 'mail_thread.follow_started',
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    targetType: 'mail_thread',
    targetId: follow.threadId,
    alsoTargets: [{ type: 'project', id: follow.projectId }],
    metadata: { projectId: follow.projectId, followId: follow.id, days: started.days, renewed: started.renewed },
  })
  captureServer({
    event: 'mail_thread_followed',
    distinctId: session.userId,
    organizationId: session.organizationId,
    properties: { action: started.renewed ? 'renew' : 'start', days: started.days },
  })
}

function recordFollowEnded(
  organizationId: string,
  actor: { userId: string; email: string | null },
  follow: MailThreadFollowRow,
): void {
  const reason = follow.endedReason ?? 'unfollowed'
  recordAuditEventAfterCommit({
    action: 'mail_thread.follow_ended',
    organizationId,
    actor,
    targetType: 'mail_thread',
    targetId: follow.threadId,
    alsoTargets: [{ type: 'project', id: follow.projectId }],
    metadata: { projectId: follow.projectId, followId: follow.id, reason, followerUserId: follow.userId },
    idempotencyKey: `mail_thread.follow_ended:${follow.id}`,
  })
  captureServer({
    event: 'mail_thread_followed',
    // A system end is personless: nobody acted.
    distinctId: follow.endedBy,
    organizationId,
    properties: { action: 'end', reason },
  })
}
