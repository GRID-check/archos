import 'server-only'
/**
 * The E-Mail-Eingang's notices (ADR-0134, DECISION §9 „Postfach types“): who
 * is told what about project mail, and when a notice is settled. Seven types,
 * all in-app and push only (we never send mail about mail):
 *
 * | Type | Told to | Row | Settled |
 * |---|---|---|---|
 * | `inbound_mail.waiting` | the sender per D9, else the managers | per project | nothing waits |
 * | `inbound_mail.expiring` | the same, once per mail (sweep 4) | per project | nothing told about waits |
 * | `inbound_mail.decided` | the member sender per D9 | per mail | — |
 * | `inbound_mail.filing_failed` | the decider | per mail | filed again or dismissed |
 * | `inbound_mail.cap_reached` | the managers | per address | below 80%, or a new address |
 * | `inbound_mail.appended` | the follower | per Verlauf and day | — |
 * | `mail_thread.follow_expiring` | the follower, once (sweep 12) | per follow | renewed or ended |
 *
 * Who is told about a mail (D9, RT-S14):
 * - the sender, when the mail is `member_verified`, addressed to the project
 *   (or the member's own Bcc copy, D4) and the member may read the project:
 *   their own mail waits for them, and its outcome is theirs to hear;
 * - otherwise the project's managers (`project:manage`). A `member_unverified`
 *   mail never notifies the member it names: whoever forged their address must
 *   not reach them through us.
 *
 * What a row says: the project's name, a count, a code. No sender, no subject,
 * no file name reaches a row or a push, so a stranger's words never land on a
 * lock screen (redacted by construction, RT-X1); mail from an unconfirmed
 * domain or sent automatically adds a line saying so (`unconfirmed`). A
 * decided mail names its folder only when the member may open it.
 *
 * Telling once is the caller's: the receive job marks `notified_at`, the
 * sweeps compare-and-set `expiring_notified_at` and the address's
 * `cap_notice` before telling, the filing job tells a decision when it is
 * the run that ended the mail. Best effort: the fact is stored before this
 * runs, and a lost row costs a notification, never the mail.
 */

import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { isFolderVisibleToMember } from '@/lib/authz/folder-access'
import type { InboxItemType } from '@/lib/db/schema'
import { memberReader } from '@/lib/documents/document-reader'
import type {
  InboundMailCapNotice,
  InboundMailFilingFailure,
  InboundSenderTrust,
  SenderFlag,
} from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { appendedGroupAnchor, inboxGroupKey } from '@/lib/inbox/registry'
import {
  emitInboxItems,
  openRecipientsOf,
  resolveInboxItemsAnchoredOn,
  resolveInboxItemsFor,
  type InboxEmission,
} from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { findThreadRow } from '@/lib/mail-thread/write-repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { filedFolderIds, projectNoticeState } from './notice-repository'
import { findLiveFolders } from './repository'

export const INBOUND_MAIL_WAITING = 'inbound_mail.waiting' as const
export const INBOUND_MAIL_EXPIRING = 'inbound_mail.expiring' as const
export const INBOUND_MAIL_DECIDED = 'inbound_mail.decided' as const
export const INBOUND_MAIL_FILING_FAILED = 'inbound_mail.filing_failed' as const
export const INBOUND_MAIL_CAP_REACHED = 'inbound_mail.cap_reached' as const
export const INBOUND_MAIL_APPENDED = 'inbound_mail.appended' as const
export const MAIL_THREAD_FOLLOW_EXPIRING = 'mail_thread.follow_expiring' as const

/** What the announcement reads of a held mail. Ids and labels only. */
export interface WaitingMail {
  organizationId: string
  projectId: string
  mailId: string
  senderTrust: InboundSenderTrust
  senderUserId: string | null
  senderFlags: readonly SenderFlag[]
  automatic: boolean
}

/**
 * Whether the mail's own sender is the one to tell (D9): a verified member's
 * mail to the project, or their own Bcc copy. Pure; whether they may read the
 * project is asked by {@link waitingRecipients}.
 */
export function notifiesSender(mail: Pick<WaitingMail, 'senderTrust' | 'senderUserId' | 'senderFlags'>): boolean {
  if (mail.senderTrust !== 'member_verified' || !mail.senderUserId) return false
  return !mail.senderFlags.includes('not_addressed_to_project') || mail.senderFlags.includes('bcc_own')
}

/** Whether the row says that mail from an unconfirmed domain, or automatic mail, is among what waits. */
export function isUnconfirmed(mail: Pick<WaitingMail, 'senderTrust' | 'automatic'>): boolean {
  return mail.automatic || mail.senderTrust === 'external_unverified' || mail.senderTrust === 'member_unverified'
}

const holds = (organizationId: string, projectId: string, userId: string, permission: 'project:view' | 'project:manage') =>
  userHoldsProjectPermission({ organizationId }, projectId, userId, permission).catch(() => false)

/**
 * Every member who manages the project (`project:manage`). The directory is
 * the whole roster; an unreadable one tells nobody, and says so in the log.
 */
export async function projectManagers(organizationId: string, projectId: string, label: string): Promise<string[]> {
  const directory = await loadOrganizationDirectory(organizationId)
  if (directory.size === 0) console.warn(`[inbound-mail] nobody to tell about ${label}: the directory is empty`)
  const verdicts = await Promise.all(
    [...directory.keys()].map(async (userId) => ((await holds(organizationId, projectId, userId, 'project:manage')) ? userId : null)),
  )
  return verdicts.filter((userId): userId is string => userId !== null)
}

type SenderFacts = Pick<WaitingMail, 'organizationId' | 'projectId' | 'senderTrust' | 'senderUserId' | 'senderFlags'>

/** The sender, when they are the one told about the mail (D9) and may still read the project; else null. */
async function senderToTell(mail: SenderFacts): Promise<string | null> {
  if (!notifiesSender(mail) || !mail.senderUserId) return null
  return (await holds(mail.organizationId, mail.projectId, mail.senderUserId, 'project:view')) ? mail.senderUserId : null
}

/** Who is told about this mail: its sender (see {@link notifiesSender}) when they may read the project, else its managers. */
export async function waitingRecipients(mail: WaitingMail): Promise<string[]> {
  const sender = await senderToTell(mail)
  return sender ? [sender] : projectManagers(mail.organizationId, mail.projectId, `mail ${mail.mailId}`)
}

/** The rows for one held mail: one per recipient, folding into the project's row. Null when the project is gone. */
export async function waitingEmissions(mail: WaitingMail, recipients: readonly string[]): Promise<InboxEmission[] | null> {
  return projectEmissions(INBOUND_MAIL_WAITING, mail, recipients)
}

/** A collapsed per-project row (`waiting`, `expiring`) for each recipient, anchored on the newest mail. */
async function projectEmissions(
  type: typeof INBOUND_MAIL_WAITING | typeof INBOUND_MAIL_EXPIRING,
  mail: WaitingMail,
  recipients: readonly string[],
): Promise<InboxEmission[] | null> {
  const project = await findProjectInOrg(mail.projectId, mail.organizationId)
  if (!project) return null
  const payload = { subject: project.name, ...(isUnconfirmed(mail) ? { variant: 'unconfirmed' } : {}) }
  return recipients.map((recipientUserId) => ({
    organizationId: mail.organizationId,
    recipientUserId,
    type,
    resourceType: 'project',
    resourceId: mail.projectId,
    anchorId: mail.mailId,
    // Nobody acted: a person's own mail still tells them it waits.
    actorUserId: null,
    groupKey: inboxGroupKey(type, 'project', mail.projectId),
    payload,
  }))
}

/** Write rows best effort; whether any was written. */
async function emit(label: string, organizationId: string, build: () => Promise<InboxEmission[] | null>): Promise<boolean> {
  let written = false
  await bestEffortInbox(label, organizationId, async () => {
    const emissions = await build()
    if (!emissions || emissions.length === 0) return
    written = (await emitInboxItems(emissions)) > 0
  })
  return written
}

/** Announce one held mail. Never throws; whether rows were written. */
export async function announceWaiting(mail: WaitingMail): Promise<boolean> {
  return emit(`${INBOUND_MAIL_WAITING} for mail ${mail.mailId}`, mail.organizationId, async () => {
    const recipients = await waitingRecipients(mail)
    return recipients.length > 0 ? waitingEmissions(mail, recipients) : null
  })
}

/**
 * Day 25 (sweep 4): the mail expires in five days. Told to whoever was told
 * it waits, in the project's collapsed row. The sweep marks the mail first, so
 * this runs once per mail. Never throws.
 */
export async function announceExpiring(mail: WaitingMail): Promise<boolean> {
  return emit(`${INBOUND_MAIL_EXPIRING} for mail ${mail.mailId}`, mail.organizationId, async () => {
    const recipients = await waitingRecipients(mail)
    return recipients.length > 0 ? projectEmissions(INBOUND_MAIL_EXPIRING, mail, recipients) : null
  })
}

/** Resolve the open rows of one group key, for everyone who holds one. */
async function settleGroup(organizationId: string, groupKey: string): Promise<number> {
  const recipients = await openRecipientsOf(organizationId, groupKey)
  if (recipients.length === 0) return 0
  return resolveInboxItemsFor(recipients.map((recipientUserId) => ({ organizationId, recipientUserId, groupKey })))
}

/**
 * Settle a project's collapsed rows that no longer describe anything: `waiting`
 * once no part of the project's mail waits for a person, `expiring` once none
 * of the mail it told about does. Called after every decision, filing, expiry
 * and settle. A row anchors on the newest mail it counts, so it is settled by
 * what the project still holds, never by the one mail that just ended. Never
 * throws.
 */
export async function settleProjectNotices(organizationId: string, projectId: string): Promise<void> {
  await bestEffortInbox(`inbound mail notices of project ${projectId}`, organizationId, async () => {
    const state = await projectNoticeState(projectId)
    if (!state.waiting) await settleGroup(organizationId, inboxGroupKey(INBOUND_MAIL_WAITING, 'project', projectId))
    if (!state.expiring) await settleGroup(organizationId, inboxGroupKey(INBOUND_MAIL_EXPIRING, 'project', projectId))
  })
}

/** A mail whose outcome its member sender is told (D9): what was decided, and by whom. */
export interface DecidedMail extends Pick<WaitingMail, 'organizationId' | 'projectId' | 'mailId' | 'senderUserId' | 'senderFlags'> {
  senderTrust: InboundSenderTrust | null
  /** The person who decided; their own mail is not news to them. */
  decidedBy: string
  outcome: 'filed' | 'dismissed'
}

/**
 * The one folder every filed part went to, when the member may open it: the
 * row's anchor (its link opens Dateien there) and its name. Null otherwise:
 * files in several folders, in the root, or in one the member may not see
 * (RT-S13: a folder's name is content).
 */
async function visibleFolder(mail: DecidedMail, recipient: string): Promise<{ id: string; path: string } | null> {
  if (mail.outcome !== 'filed') return null
  // As the member reads them: a file held from them by its screening names no folder.
  const folders = new Set(await filedFolderIds(mail.mailId, memberReader(recipient)))
  const [only] = [...folders]
  if (folders.size !== 1 || !only) return null
  if (!(await isFolderVisibleToMember(mail.organizationId, mail.projectId, only, recipient))) return null
  const path = (await findLiveFolders(mail.projectId, [only])).get(only)
  return path ? { id: only, path } : null
}

/**
 * A member's own verified mail was decided (D9): tell them, once. The caller
 * is the run that ended the mail (the filing job when it filed the last part,
 * the dismissal when it dismissed what waited). Never the managers, never for
 * an unverified sender. Never throws; whether a row was written.
 */
export async function announceDecided(mail: DecidedMail): Promise<boolean> {
  const { senderTrust } = mail
  if (!senderTrust) return false
  return emit(`${INBOUND_MAIL_DECIDED} for mail ${mail.mailId}`, mail.organizationId, async () => {
    const recipient = await senderToTell({ ...mail, senderTrust })
    if (!recipient) return null
    const project = await findProjectInOrg(mail.projectId, mail.organizationId)
    if (!project) return null
    const folder = await visibleFolder(mail, recipient)
    return [
      {
        organizationId: mail.organizationId,
        recipientUserId: recipient,
        type: INBOUND_MAIL_DECIDED,
        resourceType: 'project',
        resourceId: mail.projectId,
        // The row opens Dateien at the folder it names; it folds per mail.
        anchorId: folder?.id ?? null,
        actorUserId: mail.decidedBy,
        groupKey: inboxGroupKey(INBOUND_MAIL_DECIDED, 'project', mail.projectId, mail.mailId),
        payload: {
          subject: project.name,
          ...(mail.outcome === 'dismissed' ? { variant: 'dismissed' } : {}),
          ...(folder ? { related: folder.path } : {}),
        },
      },
    ]
  })
}

/** A filing that made no document for some part of a mail the reader decided. */
export interface FilingFailure {
  organizationId: string
  projectId: string
  mailId: string
  /** The person who decided the filing, and whose filing failed. */
  decidedBy: string
  failure: InboundMailFilingFailure
}

/** Tell the decider their filing did not complete (the filing job, sweep 5). Never throws. */
export async function announceFilingFailed(failed: FilingFailure): Promise<boolean> {
  return emit(`${INBOUND_MAIL_FILING_FAILED} for mail ${failed.mailId}`, failed.organizationId, async () => {
    const project = await findProjectInOrg(failed.projectId, failed.organizationId)
    if (!project) return null
    return [
      {
        organizationId: failed.organizationId,
        recipientUserId: failed.decidedBy,
        type: INBOUND_MAIL_FILING_FAILED,
        resourceType: 'project',
        resourceId: failed.projectId,
        anchorId: failed.mailId,
        actorUserId: null,
        groupKey: inboxGroupKey(INBOUND_MAIL_FILING_FAILED, 'project', failed.projectId, failed.mailId),
        payload: { subject: project.name, variant: failed.failure },
      },
    ]
  })
}

/** These mails were decided again (filed or dismissed): their failed filings are no longer anyone's to do. Never throws. */
export async function settleFilingFailed(organizationId: string, mailIds: readonly string[]): Promise<void> {
  await bestEffortInbox(`${INBOUND_MAIL_FILING_FAILED} settled`, organizationId, async () => {
    for (const mailId of mailIds) {
      await resolveInboxItemsAnchoredOn({ organizationId, types: [INBOUND_MAIL_FILING_FAILED], anchorId: mailId })
    }
  })
}

/** An address that nears or reached its staged-bytes cap (D18). */
export interface CapReached {
  organizationId: string
  projectId: string
  addressId: string
  notice: InboundMailCapNotice
}

/** Tell the project's managers (the cap sweep, once per rise). Never throws. */
export async function announceCapReached(cap: CapReached): Promise<boolean> {
  return emit(`${INBOUND_MAIL_CAP_REACHED} for address ${cap.addressId}`, cap.organizationId, async () => {
    const [project, managers] = await Promise.all([
      findProjectInOrg(cap.projectId, cap.organizationId),
      projectManagers(cap.organizationId, cap.projectId, `address ${cap.addressId}`),
    ])
    if (!project) return null
    return managers.map((recipientUserId) => ({
      organizationId: cap.organizationId,
      recipientUserId,
      type: INBOUND_MAIL_CAP_REACHED,
      resourceType: 'project',
      resourceId: cap.projectId,
      anchorId: cap.addressId,
      actorUserId: null,
      groupKey: inboxGroupKey(INBOUND_MAIL_CAP_REACHED, 'project', cap.projectId, cap.addressId),
      payload: { subject: project.name, variant: cap.notice },
    }))
  })
}

/** The address is below 80% again, or was replaced: settle its rows. Never throws. */
export async function settleCapReached(organizationId: string, addressId: string): Promise<void> {
  await bestEffortInbox(`${INBOUND_MAIL_CAP_REACHED} settled`, organizationId, () =>
    resolveInboxItemsAnchoredOn({ organizationId, types: [INBOUND_MAIL_CAP_REACHED], anchorId: addressId }),
  )
}

/** A reply's text a follow appended to a Verlauf (D31), as the follower. */
export interface AppendedReply {
  organizationId: string
  projectId: string
  mailId: string
  /** The Verlauf it went into: the row points at its document. */
  threadId: string
  followerUserId: string
  /** When it was appended; its day is the row's fold. */
  at?: Date
}

/**
 * Tell the follower a reply's text went into their Verlauf (the follow job,
 * D10): one counted row per Verlauf and day, on the Verlauf's document, so its
 * link re-checks their access to it when read. Nothing when the Verlauf has no
 * document. Never throws.
 */
export async function announceAppended(reply: AppendedReply): Promise<boolean> {
  return emit(`${INBOUND_MAIL_APPENDED} for mail ${reply.mailId}`, reply.organizationId, async () => {
    const [project, thread] = await Promise.all([
      findProjectInOrg(reply.projectId, reply.organizationId),
      findThreadRow(reply.projectId, reply.threadId),
    ])
    if (!project || !thread?.documentId) return null
    return [
      {
        organizationId: reply.organizationId,
        recipientUserId: reply.followerUserId,
        type: INBOUND_MAIL_APPENDED,
        resourceType: 'document',
        resourceId: thread.documentId,
        anchorId: reply.mailId,
        // The follow acted, not the follower: their own append still tells them.
        actorUserId: null,
        groupKey: inboxGroupKey(INBOUND_MAIL_APPENDED, 'document', thread.documentId, appendedGroupAnchor(reply.at ?? new Date())),
        payload: { subject: project.name },
      },
    ]
  })
}

/** A follow that ends in five days. */
export interface ExpiringFollow {
  organizationId: string
  projectId: string
  followId: string
  threadDocumentId: string
  followerUserId: string
}

/** Day 55 (sweep 12): ask the follower to renew. The sweep marks the follow first. Never throws. */
export async function announceFollowExpiring(follow: ExpiringFollow): Promise<boolean> {
  return emit(`${MAIL_THREAD_FOLLOW_EXPIRING} for follow ${follow.followId}`, follow.organizationId, async () => {
    const project = await findProjectInOrg(follow.projectId, follow.organizationId)
    if (!project) return null
    return [
      {
        organizationId: follow.organizationId,
        recipientUserId: follow.followerUserId,
        type: MAIL_THREAD_FOLLOW_EXPIRING,
        resourceType: 'document',
        resourceId: follow.threadDocumentId,
        anchorId: follow.followId,
        actorUserId: null,
        groupKey: inboxGroupKey(MAIL_THREAD_FOLLOW_EXPIRING, 'document', follow.threadDocumentId, follow.followId),
        payload: { subject: project.name },
      },
    ]
  })
}

/** These follows were renewed or ended: their renewal is no longer asked for (D10, sweeps 9 and 12). Never throws. */
export async function settleFollowExpiring(organizationId: string, followIds: readonly string[]): Promise<void> {
  await bestEffortInbox(`${MAIL_THREAD_FOLLOW_EXPIRING} settled`, organizationId, async () => {
    for (const followId of followIds) {
      await resolveInboxItemsAnchoredOn({ organizationId, types: [MAIL_THREAD_FOLLOW_EXPIRING], anchorId: followId })
    }
  })
}

/** Every type this module writes: the E-Mail-Eingang's part of the inbox vocabulary. */
export const INBOUND_MAIL_INBOX_TYPES: readonly InboxItemType[] = [
  INBOUND_MAIL_WAITING,
  INBOUND_MAIL_EXPIRING,
  INBOUND_MAIL_DECIDED,
  INBOUND_MAIL_FILING_FAILED,
  INBOUND_MAIL_CAP_REACHED,
  INBOUND_MAIL_APPENDED,
  MAIL_THREAD_FOLLOW_EXPIRING,
]
