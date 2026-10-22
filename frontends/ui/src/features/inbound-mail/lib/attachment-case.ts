/**
 * What one attachment of a held mail is, for the row that shows it: its
 * state, the facts the reader must see before filing it, and whether it is
 * offered checked (DECISION §9, the case table).
 *
 * Whether it is offered checked is the server's (`part.preselected`,
 * `lib/inbound-mail/review-defaults.ts`): a part is offered checked only when
 * filing it needs nothing from the person, and nothing of an impersonation
 * is. This module says why a part is not, as notes the row words, or that it
 * is not offered at all when it cannot be filed (still in the original `.eml`).
 *
 * Pure.
 */

import type { InboundMailPartView, InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'
import type { NotStagedReason, PartRiskFlag } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { isImageInMail, revisionVouched, senderFactsOfView } from '@/lib/inbound-mail/review-defaults'

/** Where the attachment stands. Only `waiting` can be decided. */
export type AttachmentStatus =
  | 'waiting'
  | 'filing'
  | 'filed'
  | 'dismissed'
  | 'expired'
  | 'scan_pending'
  | 'scan_failed'
  | 'scan_infected'
  | 'not_offered'

/** The risk flags filing needs the person's explicit yes for (`acknowledgeRisk`). */
export type AcknowledgedRisk = Extract<PartRiskFlag, 'macro' | 'type_mismatch' | 'unverified_thread'>

/** One fact about a waiting attachment, worded by the row. */
export type AttachmentNote =
  | { kind: 'duplicate'; name: string; folderPath: string | null; documentId: string }
  | { kind: 'revision'; name: string; folderPath: string | null; nextVersion: number; documentId: string; verified: boolean }
  | { kind: 'revision_hidden' }
  | { kind: 'name_stop'; terms: string[] }
  | { kind: 'risk'; flag: 'macro' | 'type_mismatch' }
  | { kind: 'encrypted' }
  | { kind: 'forwarded_inner' }
  | { kind: 'image_in_mail' }
  | { kind: 'last_failure'; failure: NonNullable<InboundMailPartView['lastFailure']> }

export interface AttachmentCase {
  part: InboundMailPartView
  status: AttachmentStatus
  /** The person may check it: waiting, scanned clean, a type the office files, and the project open. */
  selectable: boolean
  /** Offered checked: the server's `preselected`. */
  defaultChecked: boolean
  notes: AttachmentNote[]
  /** The risk filing it would need acknowledged, if any (beyond a chosen earlier Fassung). */
  risk: AcknowledgedRisk | null
  /** Whether a thumbnail may be drawn: an image or a PDF whose scan was clean (RT-S19). */
  previewable: boolean
}

const PREVIEW_TYPES = /^(?:image\/(?:png|jpe?g|gif|webp|avif)|application\/pdf)$/i
/** A thumbnail needs the bytes in the browser; past this it is not worth the download. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024

function statusOf(part: InboundMailPartView): AttachmentStatus {
  if (part.state === 'filed' || part.state === 'filing' || part.state === 'dismissed' || part.state === 'expired') return part.state
  if (!part.offered || part.riskFlags.includes('type_not_accepted')) return 'not_offered'
  if (part.scan === 'pending') return 'scan_pending'
  if (part.scan === 'failed') return 'scan_failed'
  if (part.scan === 'infected') return 'scan_infected'
  return 'waiting'
}

export function attachmentCase(
  part: InboundMailPartView,
  mail: Pick<InboundMailView, 'projectClosed' | 'sender'>,
): AttachmentCase {
  const status = statusOf(part)
  const notes: AttachmentNote[] = []

  if (part.lastFailure) notes.push({ kind: 'last_failure', failure: part.lastFailure })
  if (part.duplicateOf) {
    notes.push({ kind: 'duplicate', name: part.duplicateOf.name, folderPath: part.duplicateOf.folderPath, documentId: part.duplicateOf.documentId })
  }
  const revisionVerified = revisionVouched(part, senderFactsOfView(mail))
  if (part.revisionCandidate) {
    notes.push({
      kind: 'revision',
      name: part.revisionCandidate.name,
      folderPath: part.revisionCandidate.folderPath,
      nextVersion: part.revisionCandidate.nextVersion,
      documentId: part.revisionCandidate.documentId,
      verified: revisionVerified,
    })
  } else if (part.revisionCandidateHidden) {
    notes.push({ kind: 'revision_hidden' })
  }
  if (part.riskFlags.includes('name_stop')) notes.push({ kind: 'name_stop', terms: part.nameStopTerms })
  const risk: AcknowledgedRisk | null = part.riskFlags.includes('macro')
    ? 'macro'
    : part.riskFlags.includes('type_mismatch')
      ? 'type_mismatch'
      : null
  if (risk === 'macro' || risk === 'type_mismatch') notes.push({ kind: 'risk', flag: risk })
  if (part.riskFlags.includes('encrypted')) notes.push({ kind: 'encrypted' })
  if (part.riskFlags.includes('forwarded_inner')) notes.push({ kind: 'forwarded_inner' })
  if (isImageInMail(part)) notes.push({ kind: 'image_in_mail' })

  const selectable = status === 'waiting' && !mail.projectClosed
  return {
    part,
    status,
    selectable,
    defaultChecked: selectable && part.preselected,
    notes,
    risk,
    previewable: part.scan === 'clean' && PREVIEW_TYPES.test(part.contentType) && part.sizeBytes <= PREVIEW_MAX_BYTES && status !== 'filed',
  }
}

/** The files of the mail that never became parts, grouped as the detail lists them; layout images are only counted. */
export interface NotStagedSummary {
  /** Shown one per line with why: they are only in the original. */
  listed: Array<{ filename: string; reason: Exclude<NotStagedReason, 'embedded' | 'signature' | 'empty'> }>
  /** Signature logos and pasted layout images, counted. */
  layoutImages: number
}

export function notStagedSummary(notStaged: InboundMailView['notStaged']): NotStagedSummary {
  const listed: NotStagedSummary['listed'] = []
  let layoutImages = 0
  for (const entry of notStaged) {
    if (entry.reason === 'embedded') layoutImages += 1
    else if (entry.reason === 'signature' || entry.reason === 'empty') continue
    else listed.push({ filename: entry.filename, reason: entry.reason })
  }
  return { listed, layoutImages }
}
