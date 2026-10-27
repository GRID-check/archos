import 'server-only'
/**
 * The follow job (`inbound_mail_follow`, ADR-0137, DECISION D31 and §6
 * "Follow"): a reply to a followed E-Mail-Verlauf has its TEXT appended to the
 * thread as the follower, without a click, and only while every one of D31's
 * nine conditions holds. The receive job queued it because conditions 1–6
 * held then; nothing it read then is trusted now. Per run:
 *
 * 1. **The mail.** Still waiting, its text still waiting. A text this job
 *    already decided and could not finish (the thread was busy, the process
 *    died) is filed on that decision, as its decider.
 * 2. **Conditions 1–6 again** (`judgeFollow`, the receive job's own reading):
 *    the earliest running follow made before the mail arrived, a verified
 *    sender, a signed `reference` match, no refusing flag, no new participant
 *    domain, nothing the name or content check found. That follow's person is
 *    the follower, whichever follow the receive job named.
 * 3. **Conditions 7 and 9, as the follower** (resolved now, strictly: a
 *    directory that does not answer retries, it never reads as "left"): the
 *    office's `inbound-mail` entitlement; the thread document live (deleted,
 *    archived or binned ends the follow, `document_gone`), screened, and
 *    readable to them; `project:documents:write` in an open project and write
 *    in the document's folder. A follower who left or lost the project or the
 *    folder ends the follow (`access_lost`); a closed project or a held
 *    document only makes the mail wait.
 * 4. **Condition 8 and the decision**, in one transaction
 *    (`writeFollowDecision`): the follow still running, the mail still
 *    waiting, the follow's and the project's appends of the last day under
 *    their caps; then the follower's decision (`via = 'follow'`, `append`,
 *    the text as sent) and the text's claim. The decision is audited and
 *    scored like a person's (`mail-thread-match` = `followed`, `via: follow`).
 * 5. **The filing**, by the filing job's own step (`runInboundMailFiling`) in
 *    the follower's session: the ordinary upload path, quiet, under the
 *    thread's render lease. It files exactly the decided text; every
 *    attachment still waits for a person, and so the mail stays in the
 *    E-Mail-Eingang unless it brought none.
 *
 * Whenever a condition fails, the mail simply waits, exactly as it would
 * without a follow; nothing is written for it. The run's one log line names
 * the mail and the outcome code, never a sender, subject or address.
 */

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { captureServer } from '@/lib/analytics/posthog-server'
import { resolvePinnedRequesterSessionStrict } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isInboundMailEnabled } from '@/lib/authz/feature-flags'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import { memberReader, SCREENED_ONLY } from '@/lib/documents/document-reader'
import {
  requesterOf,
  type InboundMailFollowPayload,
  type JobSliceResult,
} from '@/lib/jobs-queue/types'
import { RENDER_LEASE_RETRY_MS } from '@/lib/mail-thread/append'
import type { FollowRow } from '@/lib/mail-thread/follow-eligibility'
import { findThreadDocumentState, writeFollowDecision } from '@/lib/mail-thread/follow-repository'
import { endFollowBySystem } from '@/lib/mail-thread/follows'
import { findWritableThread } from '@/lib/mail-thread/write-repository'
import { isProjectClosedError } from '@/lib/projects/project-status'
import { inboundMailDomain } from './address'
import { announceAppended } from './announce'
import { auditDecisions } from './audit'
import { threadIsFull } from './candidates'
import { THREAD_DOCUMENT_TYPE } from './decision'
import { runInboundMailFiling } from './file-job'
import { findFilingWork, type FilingWork } from './filing-repository'
import { judgeFollow } from './follow-candidate'
import { findFiledMessages, findMailParts } from './repository'
import { FILING_CLAIM_MS, hoursWaitingBucket } from './service'
import { scoreMailDecision } from './suggest-scores'

/** Why a reply's text waits for a person although its thread is followed. */
export const FOLLOW_WAIT_REASONS = [
  /** The mail or its text is no longer waiting: a person decided first. */
  'not_waiting',
  /** One of D31's conditions 1–6 failed (`FOLLOW_INELIGIBILITY_REASONS`). */
  'ineligible',
  /** The office's `inbound-mail` entitlement is off for the follower. */
  'disabled',
  /** The project is closed (condition 9). */
  'project_closed',
  /** The thread document is held by its screening, or not yet readable to the follower (condition 9). */
  'document_held',
  /** The thread is at its entry or byte cap (condition 8). */
  'thread_full',
  /** The text could not be read; only a person can file its original. */
  'unreadable',
  /** A message with this Message-ID is already in a thread of the project. */
  'already_filed',
  /** The follow ended, ran out, or was made after the mail arrived (condition 1, under the lock). */
  'follow_not_running',
  /** The follow made its appends for the day (condition 8). */
  'follow_cap',
  /** The project's follows made theirs (condition 8). */
  'project_cap',
  /** The upload path refused the thread's next Fassung: the text waits with that failure. */
  'not_filed',
] as const
export type FollowWaitReason = (typeof FOLLOW_WAIT_REASONS)[number]

/** What one run did. */
export type FollowOutcome =
  | { kind: 'appended' }
  /** Another filing holds the thread's render lease: the run tries again shortly. */
  | { kind: 'busy' }
  | { kind: 'waits'; reason: FollowWaitReason }
  /** The follow ended, and the mail waits. */
  | { kind: 'ended'; reason: 'access_lost' | 'document_gone' }

const waits = (reason: FollowWaitReason): FollowOutcome => ({ kind: 'waits', reason })

/** The slice: one mail, then „not yet“ while another filing holds its thread. */
export async function runInboundMailFollow(
  organizationId: string,
  payload: InboundMailFollowPayload,
): Promise<JobSliceResult<InboundMailFollowPayload>> {
  const outcome = await followMail(organizationId, payload)
  console.debug(
    `[inbound-mail] follow of mail ${payload.mailId}: ${outcome.kind}${'reason' in outcome ? `:${outcome.reason}` : ''}`,
  )
  return outcome.kind === 'busy'
    ? { done: false, payload, notBefore: new Date(Date.now() + RENDER_LEASE_RETRY_MS) }
    : { done: true, payload }
}

/** Steps 1–5 of the module header. Exported for its spec. */
export async function followMail(organizationId: string, payload: InboundMailFollowPayload): Promise<FollowOutcome> {
  const [work] = await findFilingWork(payload.projectId, [payload.mailId])
  if (!work || work.mail.organizationId !== organizationId) return waits('not_waiting')
  const text = work.parts.find((part) => part.kind === 'message')
  if (!text) return waits('not_waiting')
  if (text.state === 'filing') return resumeDecided(organizationId, payload, work, text)
  if (text.state !== 'waiting') return waits('not_waiting')

  const domain = inboundMailDomain()
  if (!domain) throw new Error('GRID_INBOUND_MAIL_DOMAIN is not set: a followed reply cannot be judged')
  const judged = await judgeFollow(work.mail, text.contentFindings.length, domain, null)
  if (!judged?.eligibility.eligible) return waits('ineligible')
  const { follow } = judged.eligibility
  const threadId = judged.thread.threadId

  const session = await followerSession(organizationId, follow.userId, payload)
  if (!session) return endFollow(follow, 'access_lost')
  const refused = await followerMayAppend(session, payload.projectId, threadId, follow)
  if (refused) return refused
  if (!work.mail.readStorageKey || text.riskFlags.includes('unreadable')) return waits('unreadable')
  if (work.mail.messageId && (await findFiledMessages(payload.projectId, work.mail.messageId)).length > 0)
    return waits('already_filed')

  const now = new Date()
  const written = await writeFollowDecision({
    follow: { id: follow.id, userId: follow.userId, threadId },
    mail: {
      id: work.mail.id,
      organizationId,
      projectId: payload.projectId,
      receivedAt: new Date(work.mail.receivedAt),
    },
    partId: text.id,
    // Condition 6 found nothing to mask, so the text goes in as sent.
    decision: { messageText: 'full', documentType: THREAD_DOCUMENT_TYPE },
    claimExpiresAt: new Date(now.getTime() + FILING_CLAIM_MS),
    now,
  })
  if (written.kind !== 'written') return waits(written.kind)
  await auditDecisions([written.decision])
  recordFollowDecision(session, work, text, threadId, now)
  return fileDecided(session, payload, written.decision.id, threadId)
}

/** A text this job decided and did not finish filing: filed on that decision, as its decider. */
async function resumeDecided(
  organizationId: string,
  payload: InboundMailFollowPayload,
  work: FilingWork,
  text: InboundMailPartRow,
): Promise<FollowOutcome> {
  const decision = work.decisions.get(text.id)
  if (decision?.via !== 'follow') return waits('not_waiting')
  const session = await followerSession(organizationId, decision.decidedBy, payload)
  // The claim runs out and the claim sweep hands the text back to a person.
  if (!session) return waits('not_waiting')
  return fileDecided(session, payload, decision.id, decision.mailThreadId)
}

/**
 * The follower's session today, strictly: a directory that does not answer
 * throws for the queue to retry, and only a real "not a member" is null.
 */
function followerSession(
  organizationId: string,
  userId: string,
  payload: InboundMailFollowPayload,
): Promise<AuthorizedSession | null> {
  const email = payload.requester.userId === userId ? payload.requester.email : null
  return resolvePinnedRequesterSessionStrict({ userId, email, organizationId })
}

/**
 * Conditions 7 and 9 as the follower (step 3 of the module header), and the
 * thread's caps. Null when they may append; otherwise the outcome, after
 * ending the follow where the condition that failed says so.
 */
async function followerMayAppend(
  session: AuthorizedSession,
  projectId: string,
  threadId: string,
  follow: FollowRow,
): Promise<FollowOutcome | null> {
  if (!isInboundMailEnabled(session)) return waits('disabled')
  const state = await findThreadDocumentState(projectId, threadId, memberReader(session.userId))
  if (state === 'gone') return endFollow(follow, 'document_gone')
  if (state === 'unseen') return waits('document_held')
  // Live for the follower, who may see their own held upload: it must have passed screening.
  const thread = await findWritableThread(projectId, threadId, SCREENED_ONLY)
  if (!thread) return waits('document_held')
  try {
    await requireFolderWrite(session, projectId, [thread.document.folderId])
  } catch (error) {
    if (isProjectClosedError(error)) return waits('project_closed')
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return endFollow(follow, 'access_lost')
    throw error
  }
  if (threadIsFull(thread.thread)) return waits('thread_full')
  return null
}

async function endFollow(follow: FollowRow, reason: 'access_lost' | 'document_gone'): Promise<FollowOutcome> {
  await endFollowBySystem(follow, reason)
  return { kind: 'ended', reason }
}

/**
 * Step 5: the filing job's own step, as the follower, on this job's own
 * decision only (a person who decided the mail's attachments meanwhile files
 * them in their own run); what became of the text. An appended text tells the follower (`inbound_mail.appended`); the
 * filing step itself settles the project's collapsed rows when the mail ends.
 */
async function fileDecided(
  session: AuthorizedSession,
  payload: InboundMailFollowPayload,
  decisionId: string,
  threadId: string | null,
): Promise<FollowOutcome> {
  const filed = await runInboundMailFiling(session, {
    projectId: payload.projectId,
    mailIds: [payload.mailId],
    decisionIds: [decisionId],
    requester: requesterOf(session),
  })
  if (!filed.done) return { kind: 'busy' }
  // Read without the status filter: a text-only mail settled with this filing.
  const text = (await findMailParts([payload.mailId])).find((part) => part.kind === 'message')
  if (text?.state !== 'filed') return waits('not_filed')
  if (threadId) {
    await announceAppended({
      organizationId: session.organizationId,
      projectId: payload.projectId,
      mailId: payload.mailId,
      threadId,
      followerUserId: session.userId,
    })
  }
  return { kind: 'appended' }
}

/** The decision's score and PostHog event, as a person's decision has them (D14, §10). */
function recordFollowDecision(
  session: AuthorizedSession,
  work: FilingWork,
  text: InboundMailPartRow,
  threadId: string,
  now: Date,
): void {
  const mail: InboundMailRow = work.mail
  // Scored on the text alone: the attachments still wait, and a person's later decision scores them.
  const suggestionFollowed = scoreMailDecision({
    organizationId: session.organizationId,
    decidedBy: session.userId,
    mail,
    parts: work.parts.filter((part) => part.kind === 'message'),
    decision: { parts: [], message: { partId: text.id, text: 'full', thread: { action: 'append', mailThreadId: threadId } } },
    via: 'follow',
    folderPathOf: () => null,
    decidedAt: now,
  })
  captureServer({
    event: 'inbound_mail_decided',
    distinctId: session.userId,
    organizationId: session.organizationId,
    properties: {
      files: 1,
      dismissed: 0,
      suggestion_followed: suggestionFollowed,
      thread_action: 'append',
      hours_waiting_bucket: hoursWaitingBucket(mail.receivedAt, now.getTime()),
      via: 'follow',
    },
  })
}
