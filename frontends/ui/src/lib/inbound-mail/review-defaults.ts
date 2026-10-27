/**
 * What a held mail offers checked, and whether it can be filed „wie
 * vorgeschlagen“ without anyone looking at it (ADR-0137, DECISION §9 and its
 * case table, D11, RT-X10). The views carry the answers (`preselected` on each
 * part, `incompleteReason` and the sender's risk on the mail), so the
 * E-Mail-Eingang, the Postfach's action and an outside agent read one rule
 * instead of each deriving its own.
 *
 * The defaults are conservative on purpose. A part is offered checked only
 * when filing it needs nothing from the person:
 *
 * - an attachment: waiting, scanned clean, a type the office files, the
 *   project open; no identical bytes in the project, the name check passed,
 *   no macro or type mismatch, no picture pasted into the mail, and, as a new
 *   Fassung of an earlier document, a sender whose domain vouches for it;
 * - the text: waiting, readable, the project open, not already in a thread.
 *
 * Nothing at all is offered checked on a mail that reads as an impersonation
 * (`./sender-risk`): a forged „Kontoänderung“ must not be one press away from
 * the project, whatever its attachments look like.
 *
 * Complete means the default asks nothing of the person: no sender
 * acknowledgement (a bulk request carries none, RT-S5), the text into a
 * pre-selected thread with room (or a member's own Bcc copy with nothing
 * attached, which starts one), and every waiting attachment decided by its
 * default, with a folder for each one offered checked.
 *
 * Pure: the service applies it to the views it builds, and the specs read it
 * without a database.
 */

import { isOwnBccCopy, senderPreselectionBlocks } from '@/lib/mail-thread/mail-threading'
import type {
  InboundMailPartView,
  InboundMailThreadCandidateView,
  InboundMailView,
  IncompleteReason,
} from './inbound-mail-wire'
import type { MalwareScanStatus } from './inbound-mail-vocabulary'
import { impersonationOf, senderNeedsAcknowledgement, senderRiskLevel, type SenderFacts } from './sender-risk'

/** A part as the service reads it, before its default is known. */
export type InboundMailPartBase = Omit<InboundMailPartView, 'preselected'>

/** The fields of a view this module derives. */
type DerivedFields = 'riskLevel' | 'impersonation' | 'needsSenderAcknowledgement' | 'incompleteReason'

/** A mail as the service reads it, before what it asks of the person is known. */
export type InboundMailViewBase = Omit<InboundMailView, DerivedFields | 'parts'> & { parts: InboundMailPartBase[] }

/** The stored verdict about the sender, from the view; null once the mail is settled. */
export function senderFactsOfView(view: Pick<InboundMailView, 'sender'>): SenderFacts | null {
  return view.sender ? { trust: view.sender.trust, reason: view.sender.reason, flags: view.sender.flags } : null
}

/** An attachment a person may check at all: waiting, a type the office files, scanned clean, the project open. */
export function attachmentSelectable(part: InboundMailPartBase, projectClosed: boolean): boolean {
  return (
    part.kind === 'attachment' &&
    part.state === 'waiting' &&
    part.offered &&
    !part.riskFlags.includes('type_not_accepted') &&
    part.scan === 'clean' &&
    !projectClosed
  )
}

/** A picture pasted into the mail and large enough to offer („Bild in der E-Mail“); signature logos never become parts. */
export function isImageInMail(part: Pick<InboundMailPartBase, 'filename' | 'contentType'>): boolean {
  return part.filename === null && part.contentType.toLowerCase().startsWith('image/')
}

/**
 * Whether this sender vouches for an attachment as the next Fassung of an
 * earlier document: the same blocks that keep a thread from being pre-selected
 * (D11), and no `unverified_thread` on the part. Otherwise filing it as a
 * Fassung needs the part in `acknowledgeRisk`, as `./decision` refuses it.
 */
export function revisionVouched(part: Pick<InboundMailPartBase, 'riskFlags'>, sender: SenderFacts | null): boolean {
  if (!sender) return false
  if (senderPreselectionBlocks({ senderTrust: sender.trust, senderFlags: sender.flags }).length > 0) return false
  return !part.riskFlags.includes('unverified_thread')
}

/** Whether a selectable attachment carries something a person must weigh before it is filed. */
function attachmentNeedsPerson(part: InboundMailPartBase, sender: SenderFacts | null): boolean {
  return (
    part.duplicateOf !== null ||
    part.riskFlags.includes('name_stop') ||
    part.riskFlags.includes('macro') ||
    part.riskFlags.includes('type_mismatch') ||
    isImageInMail(part) ||
    (part.revisionCandidate !== null && !revisionVouched(part, sender))
  )
}

/** Whether an attachment carries a fact the row shows for a person to weigh, beyond identical bytes and a past failure. */
function asksForALook(part: InboundMailPartBase): boolean {
  return (
    part.revisionCandidate !== null ||
    part.revisionCandidateHidden ||
    isImageInMail(part) ||
    (['name_stop', 'macro', 'type_mismatch', 'encrypted', 'forwarded_inner'] as const).some((flag) => part.riskFlags.includes(flag))
  )
}

/** What of the mail decides whether its text can be filed at all. */
interface MessageContext {
  projectClosed: boolean
  /** The whole raw message's scan: a text whose raw message is not clean is never filed (`decision.ts`). */
  rawScan: MalwareScanStatus
}

/** The text a person may file at all: waiting, readable, its raw message scanned clean, the project open. */
export function messageSelectable(part: InboundMailPartBase, mail: MessageContext): boolean {
  return (
    part.kind === 'message' &&
    part.state === 'waiting' &&
    !part.riskFlags.includes('unreadable') &&
    mail.rawScan === 'clean' &&
    !mail.projectClosed
  )
}

/** Whether a part is offered checked. See the module header. */
export function partPreselected(part: InboundMailPartBase, mail: MessageContext & { sender: SenderFacts | null }): boolean {
  if (!mail.sender || impersonationOf(mail.sender) !== null) return false
  if (part.kind === 'message') return messageSelectable(part, mail) && !mail.sender.flags.includes('already_filed')
  return attachmentSelectable(part, mail.projectClosed) && !attachmentNeedsPerson(part, mail.sender)
}

/** The candidate the text goes to by default: a pre-selected thread with room (D11). */
export function defaultThread(view: Pick<InboundMailView, 'threadCandidates'>): InboundMailThreadCandidateView | null {
  return view.threadCandidates.find((candidate) => candidate.preselected && !candidate.full) ?? null
}

/** Why the mail cannot be filed as suggested without a look, the first found; null when it can. */
export function incompleteReason(view: Omit<InboundMailView, DerivedFields>): IncompleteReason | null {
  if (view.status !== 'waiting') return 'not_waiting'
  if (view.projectClosed) return 'project_closed'
  const sender = senderFactsOfView(view)
  if (!sender || senderNeedsAcknowledgement(sender)) return 'sender'

  const attachments = view.parts.filter((part) => part.kind === 'attachment')
  const waiting = attachments.filter((part) => part.state === 'waiting')
  const offered = waiting.filter((part) => part.offered && !part.riskFlags.includes('type_not_accepted'))
  if (offered.some((part) => part.scan === 'pending' || part.scan === 'failed')) return 'scanning'
  // Offered unchecked for a reason a person weighs. Identical bytes alone are not one: they are in the project already.
  if (offered.some((part) => attachmentSelectable(part, view.projectClosed) && !part.preselected && asksForALook(part))) {
    return 'needs_person'
  }

  const message = view.parts.find((part) => part.kind === 'message')
  if (message?.state === 'waiting') {
    const ownBcc = isOwnBccCopy({ senderTrust: sender.trust, senderFlags: sender.flags })
    if (!defaultThread(view) && !(ownBcc && waiting.length === 0)) return 'no_thread'
  }
  // Checked and going somewhere: as the next Fassung of its earlier document, or into the suggested folder.
  if (attachments.some((part) => part.preselected && part.revisionCandidate === null && part.suggestion === null)) return 'folder_missing'
  return null
}

/** The view with what it asks of the person: each part's default, the sender's risk, whether it is complete. */
export function withReviewDefaults(base: InboundMailViewBase): InboundMailView {
  const sender = senderFactsOfView(base)
  const parts = base.parts.map((part) => ({ ...part, preselected: partPreselected(part, { projectClosed: base.projectClosed, rawScan: base.rawScan, sender }) }))
  const view = { ...base, parts }
  return {
    ...view,
    riskLevel: senderRiskLevel(sender),
    impersonation: sender ? impersonationOf(sender) : null,
    needsSenderAcknowledgement: sender !== null && senderNeedsAcknowledgement(sender),
    incompleteReason: incompleteReason(view),
  }
}
