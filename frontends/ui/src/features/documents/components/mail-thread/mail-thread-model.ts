/**
 * What the „E-Mails“ tab decides before it draws anything (ADR-0137, D16, D36),
 * pure so each rule is tested once and the components only word it:
 *
 * - **Who follows, and what the viewer may do about it.** The viewer's own
 *   follow is found by user id; „Verlängern“ only while the follow can still
 *   grow (the database holds it to 180 days from its start); „Beenden“ on
 *   someone else's follow only for a viewer who `managesFollows`.
 * - **Which entry a link or a citation means.** `?mailEntry=` names an entry
 *   by id; a citation names a section by its heading, exactly as the thread
 *   document prints it.
 * - **What a detach keeps.** Fassungen from the one the message first appeared
 *   in up to the current one keep its section; the next is written without it.
 * - **What came with a message** (D36): each attachment as a link, as „lag
 *   schon im Projekt“, as „nicht abgelegt“ with its reason, or counted without
 *   a name when it sits in a folder the viewer may not read.
 * - **How far a sender is confirmed**, in the three words a filed message can
 *   carry: a confirmed domain, an unconfirmed one, or an archived message
 *   nobody checked; and on which entries it is said at all, so a run of
 *   replies from one confirmed domain does not repeat it on every mail.
 */

import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import type { SenderTrust } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import {
  MAIL_THREAD_FOLLOW_MAX_DAYS,
  type MailThreadAttachmentNotFiledReason,
  type MailThreadAttachmentView,
  type MailThreadEntryView,
  type MailThreadFollowView,
  type MailThreadView,
} from '@/lib/mail-thread/mail-thread-wire'

const DAY_MS = 86_400_000

/** The query parameter a link into a thread's entry carries, beside `doc` (`documentFilesHref`). */
export const MAIL_ENTRY_PARAM = 'mailEntry'

// ------------------------------------------------------------ follows

/** Where the viewer stands with this thread's follow. */
export type ViewerFollow =
  | { kind: 'none' }
  /** The viewer follows; `follow` is null only where the surface does not know who the viewer is. */
  | { kind: 'following'; follow: MailThreadFollowView | null; renewable: boolean }

/**
 * Whether a running follow can still be extended: the database holds a
 * follow to {@link MAIL_THREAD_FOLLOW_MAX_DAYS} days from its start, and a
 * renewal that would win less than a day is no renewal worth a button.
 */
export function followRenewable(follow: MailThreadFollowView): boolean {
  const ceiling = Date.parse(follow.createdAt) + MAIL_THREAD_FOLLOW_MAX_DAYS * DAY_MS
  return ceiling - Date.parse(follow.expiresAt) >= DAY_MS
}

/** The viewer's own follow, from the thread's `followed` and its list of follows. */
export function viewerFollow(view: Pick<MailThreadView, 'followed' | 'follows'>, viewerUserId: string | null | undefined): ViewerFollow {
  const own = viewerUserId ? (view.follows.find((follow) => follow.userId === viewerUserId) ?? null) : null
  if (own) return { kind: 'following', follow: own, renewable: followRenewable(own) }
  // The server says the viewer follows, but this surface cannot tell which row
  // is theirs: say so without a date, and keep „Nicht mehr folgen“.
  if (view.followed) return { kind: 'following', follow: null, renewable: false }
  return { kind: 'none' }
}

/** Everybody else's follows, oldest first, as the thread lists them. */
export function otherFollows(view: Pick<MailThreadView, 'follows'>, viewerUserId: string | null | undefined): MailThreadFollowView[] {
  return view.follows.filter((follow) => follow.userId !== viewerUserId)
}

/** Whether the viewer may end this follow: their own always, someone else's only with `managesFollows`. */
export function mayEndFollow(
  view: Pick<MailThreadView, 'managesFollows'>,
  follow: MailThreadFollowView,
  viewerUserId: string | null | undefined,
): boolean {
  return follow.userId === viewerUserId || view.managesFollows
}

/**
 * Whether the viewer may follow and detach here. The thread view tells it
 * without a second request: `waitingCount` is null unless the viewer may file
 * mail into the project, which is what following and detaching ask (the
 * routes check again, and a refusal is worded where it lands).
 */
export function mayWrite(view: Pick<MailThreadView, 'waitingCount'>): boolean {
  return view.waitingCount !== null
}

// ------------------------------------------------------------ which entry

/** Headings compared as a reader sees them: no-break spaces and runs of space are one space. */
function normalizeHeading(heading: string): string {
  return heading.replace(/[\s  ]+/g, ' ').trim()
}

/**
 * The entry a link or a citation points at: by id (`?mailEntry=`), else by
 * the section heading a citation of the thread document carries. Null when
 * neither names an entry of this thread: an old link, or a section a detach
 * moved away.
 */
export function focusedEntryId(
  entries: readonly Pick<MailThreadEntryView, 'id' | 'heading'>[],
  target: { entryId?: string | null; heading?: string | null },
): string | null {
  if (target.entryId) {
    const byId = entries.find((entry) => entry.id === target.entryId)
    if (byId) return byId.id
  }
  if (target.heading) {
    const wanted = normalizeHeading(target.heading)
    if (wanted === '') return null
    const byHeading = entries.find((entry) => normalizeHeading(entry.heading) === wanted)
    if (byHeading) return byHeading.id
  }
  return null
}

/** Newest first, as the rail's Fassung timeline reads: the latest message is the one asked about. */
export function entriesNewestFirst(entries: readonly MailThreadEntryView[]): MailThreadEntryView[] {
  // `mail-thread-get` lists the messages by send time, the order of the
  // document's sections (`render.ts`); reversing keeps the section order
  // instead of re-sorting here by a second rule that could disagree with it.
  return [...entries].reverse()
}

// ------------------------------------------------------------ Fassungen

/** The thread document's current Fassung number: its newest version, or the newest an entry names. */
export function currentVersionNumber(
  versions: readonly Pick<DocumentVersionView, 'versionNumber'>[] | null,
  entries: readonly Pick<MailThreadEntryView, 'firstVersion'>[],
): number | null {
  const numbers = [
    ...(versions ?? []).map((version) => version.versionNumber),
    ...entries.flatMap((entry) => (entry.firstVersion ? [entry.firstVersion.number] : [])),
  ]
  return numbers.length > 0 ? Math.max(...numbers) : null
}

/**
 * The two Fassungen „Vergleichen“ lays side by side for an entry: the one the
 * message first appeared in and the one before it. Null for the message that
 * started the thread, or when either Fassung is not there to read.
 */
export function comparedVersions(
  entry: Pick<MailThreadEntryView, 'firstVersion'>,
  versions: readonly Pick<DocumentVersionView, 'id' | 'versionNumber' | 'bytesReadable'>[],
): { from: { id: string; number: number }; to: { id: string; number: number } } | null {
  const first = entry.firstVersion
  if (!first || first.number < 2) return null
  const to = versions.find((version) => version.id === first.id)
  const from = versions.find((version) => version.versionNumber === first.number - 1)
  if (!to || !from || to.bytesReadable === false || from.bytesReadable === false) return null
  return { from: { id: from.id, number: from.versionNumber }, to: { id: to.id, number: to.versionNumber } }
}

/**
 * What a detach keeps and what it writes, for the confirmation: the earlier
 * Fassungen that keep the section (from the message's first to the current
 * one), and the Fassung the thread gets without it. Null when the message has
 * no Fassung of its own to name.
 */
export function detachKeeps(
  entry: Pick<MailThreadEntryView, 'firstVersion'>,
  current: number | null,
): { first: number; last: number; next: number } | null {
  if (!entry.firstVersion || current === null) return null
  const last = Math.max(current, entry.firstVersion.number)
  return { first: entry.firstVersion.number, last, next: last + 1 }
}

// ------------------------------------------------------------ attachments

/** One attachment of a message, as the entry lists it (D36). */
export type AttachmentLine =
  /** In a folder the viewer may not read: counted, never named. */
  | { kind: 'hidden'; position: number }
  /** A document of the project: the Fassung this mail brought, or the one that was already there. */
  | { kind: 'filed' | 'already_present'; position: number; name: string; documentId: string | null }
  /** Not a document: its bytes live only in the original `.eml`. */
  | { kind: 'not_filed'; position: number; name: string; reason: MailThreadAttachmentNotFiledReason | null }

/** The name an attachment shows: as it arrived, else its position („Anhang 3“ is the caller's words). */
export function attachmentLines(attachments: readonly MailThreadAttachmentView[]): AttachmentLine[] {
  return [...attachments]
    .sort((a, b) => a.position - b.position)
    .map((attachment): AttachmentLine => {
      if (!attachment.visible) return { kind: 'hidden', position: attachment.position }
      const name = attachment.filename ?? ''
      if (attachment.disposition === 'not_filed') {
        return { kind: 'not_filed', position: attachment.position, name, reason: attachment.notFiledReason ?? null }
      }
      return { kind: attachment.disposition, position: attachment.position, name, documentId: attachment.documentId ?? null }
    })
}

// ------------------------------------------------------------ trust

/** The three words a filed message's sender can carry. */
export type FiledSenderTrust = 'verified' | 'unverified' | 'not_checked'

export function filedSenderTrust(trust: SenderTrust): FiledSenderTrust {
  if (trust === 'member_verified' || trust === 'external_verified') return 'verified'
  if (trust === 'not_checked') return 'not_checked'
  return 'unverified'
}

/**
 * The entries that say their sender's trust, in the order given (the tab's,
 * newest first). A confirmed domain is said once per run of consecutive mails
 * it signed, on the first of the run: ten replies from the structural
 * engineer's domain read as one conversation, not ten certificates (the
 * owner's review, 2026-10-27). An unconfirmed sender and an archived mail
 * nobody checked are said on every mail: those are the ones a reader must not
 * miss, wherever they scroll in.
 */
export function entriesSayingTrust(entries: readonly Pick<MailThreadEntryView, 'id' | 'senderTrust' | 'signerDomain'>[]): Set<string> {
  const saying = new Set<string>()
  let run: string | null = null
  for (const entry of entries) {
    const verified = filedSenderTrust(entry.senderTrust) === 'verified'
    const key = verified ? `verified:${entry.signerDomain ?? ''}` : null
    if (key === null || key !== run) saying.add(entry.id)
    run = key
  }
  return saying
}

/**
 * A section heading split where it may wrap (`„14.10.2026, 09:12 · Mag. Huber
 * (ma37.wien.gv.at)“`): the date, the name, and the domain in parentheses,
 * each kept whole on a line where it fits. Joined, the parts are the heading
 * exactly as the document prints it, so a citation still finds it.
 */
export function headingParts(heading: string): { when: string; who: string; domain: string } {
  const split = heading.indexOf(' · ')
  if (split < 0) return { when: '', who: heading, domain: '' }
  const when = heading.slice(0, split + 3)
  const rest = heading.slice(split + 3)
  const paren = rest.lastIndexOf(' (')
  if (paren < 0 || !rest.endsWith(')')) return { when, who: rest, domain: '' }
  return { when, who: rest.slice(0, paren), domain: rest.slice(paren) }
}
