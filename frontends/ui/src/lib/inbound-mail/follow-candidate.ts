import 'server-only'
/**
 * D31's conditions 1–6 for one held mail, read from the database and its
 * staged header block, and judged by the pure `followEligibility`
 * (`lib/mail-thread/follow-eligibility.ts`). Both the receive job (whether to
 * queue `inbound_mail_follow` at all) and the follow job (re-checking, as the
 * follower, before it decides anything) ask here, so the two cannot judge one
 * mail by two readings. It reads; it never files (`review-first.spec.ts`).
 */

import type { InboundMailRow } from '@/lib/db/schema'
import {
  followEligibility,
  type FollowCandidateMail,
  type FollowEligibility,
} from '@/lib/mail-thread/follow-eligibility'
import type { ThreadMatch } from '@/lib/mail-thread/mail-threading'
import { rawHeaderFields } from './mime'
import { findThreadFollowContext, type ThreadFollowContext } from './repository'
import { mailScreeningFor } from './screening'
import { readStagedObject } from './staging'

/** The thread a mail could join by a follow, and whether conditions 1–6 hold for it. */
export interface FollowJudgement {
  thread: ThreadFollowContext
  eligibility: FollowEligibility
}

/**
 * Judge conditions 1–6 for the thread the mail matched by `reference`, or null
 * when it matched none or that thread has no live document or no follow.
 * `raw` is the staged message when the caller holds it; otherwise its header
 * block is read from staging (only which recipient fields exist is taken).
 */
export async function judgeFollow(
  mail: InboundMailRow,
  /** How many findings the content check made in the mail's own text (its message part's `content_findings`). */
  contentFindings: number,
  ownDomain: string,
  raw: Uint8Array | null,
  now: Date = new Date(),
): Promise<FollowJudgement | null> {
  const match = mail.threadMatch.find((candidate) => candidate.strength === 'reference')
  if (!match || !mail.senderTrust) return null
  const thread = await findThreadFollowContext(mail.projectId, match.threadId)
  if (!thread || thread.follows.length === 0) return null
  const screening = await mailScreeningFor(mail.organizationId, mail.projectId)
  const candidate: FollowCandidateMail = {
    receivedAt: new Date(mail.receivedAt),
    senderTrust: mail.senderTrust,
    senderFlags: mail.senderFlags,
    signedHeaders: mail.signedHeaders,
    automatic: mail.automatic,
    recipientHeaders: await recipientHeadersOf(mail, raw),
    participantAddresses: [
      ...(mail.senderAddress ? [mail.senderAddress] : []),
      ...mail.participants
        .filter((participant) => participant.role !== 'reply_to')
        .map((participant) => participant.address),
    ],
    match: match as ThreadMatch,
    subjectNameStops: screening.nameStops(mail.baseSubject ?? ''),
    contentFindings,
  }
  const eligibility = followEligibility(
    candidate,
    { id: thread.threadId, participantDomains: thread.participantDomains },
    thread.follows,
    { now, ownDomains: [ownDomain] },
  )
  return { thread, eligibility }
}

/** Which recipient fields the message carries (condition 3 needs each signed), from its header block. */
async function recipientHeadersOf(mail: InboundMailRow, raw: Uint8Array | null): Promise<Array<'to' | 'cc'>> {
  const bytes = raw ?? (mail.rawStorageKey ? await readStagedObject(mail.stagingBucket, mail.rawStorageKey) : null)
  const fields = bytes ? rawHeaderFields(bytes) : null
  if (!fields) return []
  return (['to', 'cc'] as const).filter((name) => fields.some((field) => field.name === name))
}
