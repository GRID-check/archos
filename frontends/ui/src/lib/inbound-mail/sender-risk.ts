/**
 * What a held mail's sender asks of the person before anything of it is filed
 * (ADR-0134, DECISION §4 C2, D4, RT-X6): the one place these rules are
 * written. The decision refuses by them (`./decision`), the views carry their
 * answer (`riskLevel`, `impersonation`, `needsSenderAcknowledgement` on
 * `./inbound-mail-wire`), the suggest job skips by them (`./suggest`), and the
 * browser reads the answer off the wire instead of restating it.
 *
 * DKIM proves a domain, never a person, so nothing here claims more than the
 * domain. Two things are evidence that someone is pretending, and only those
 * make a mail an `impersonation`:
 *
 * - **a rejected signature**: the From domain's own signature failed, its
 *   policy refused the mail, or it signed with a key or algorithm anyone can
 *   forge (`isRejectedSignature`);
 * - **a member's name on another address** (`claims_member_name`): the display
 *   name is a directory member's, the address is not theirs. The payment
 *   diversion mail („Dringend: Kontoänderung Honorarnote“) looks exactly so.
 *
 * A member's address that simply carries no signature is `caution`, not an
 * impersonation: most unsigned mail is a misconfigured server, and an alarm
 * raised for every one of them is one nobody reads (RT-X6).
 *
 * Pure: no database, no `server-only`.
 */

import { latinize } from '@/lib/text/latinize'
import { isOwnBccCopy } from '@/lib/mail-thread/mail-threading'
import type { ImpersonationBasis, SenderFlag, SenderReason, SenderRiskLevel, SenderTrust } from './inbound-mail-vocabulary'

/** The stored verdict about a sender, as the rules read it: the row's or the view's. */
export interface SenderFacts {
  trust: SenderTrust
  reason: SenderReason
  flags: readonly SenderFlag[]
}

/** The stored verdict of a mail row, as the rules read it; null for a mail nobody checked (never one a person reads). */
export function senderFactsOf(mail: {
  senderTrust: SenderTrust | null
  senderReason: SenderReason | null
  senderFlags: readonly SenderFlag[]
}): SenderFacts | null {
  return mail.senderTrust && mail.senderReason ? { trust: mail.senderTrust, reason: mail.senderReason, flags: mail.senderFlags } : null
}

/**
 * Reasons that say the From domain's own signature is broken, refused by
 * policy, or made with a key or algorithm too weak to prove anything, rather
 * than merely absent. Only these (and a member's name on another address) make
 * a mail an impersonation; a plain unsigned mail never is.
 */
export function isRejectedSignature(reason: SenderReason): boolean {
  return reason === 'dkim_fail' || reason === 'dkim_policy' || reason === 'dkim_weak_algorithm' || reason === 'dkim_short_key'
}

/** Why the mail reads as someone pretending, or null when nothing says so. */
export function impersonationOf(sender: SenderFacts): ImpersonationBasis | null {
  if (sender.flags.includes('claims_member_name')) return 'member_name'
  if (isRejectedSignature(sender.reason)) return 'rejected_signature'
  return null
}

/**
 * Whether filing anything of this mail needs the person to accept its sender
 * (`acknowledgeSender`, C2): an impersonation, a member's address without
 * their domain's signature, a verified mail addressed to someone else (the
 * replay of RT-S12, except a member's own recent Bcc copy), or a Date more
 * than seven days old. A plain unsigned mail from a stranger needs none: it is
 * labelled and never pre-selected, and an acknowledgement asked for every time
 * is one nobody reads (RT-X6).
 */
export function senderNeedsAcknowledgement(sender: SenderFacts): boolean {
  if (sender.trust === 'member_unverified') return true
  if (impersonationOf(sender) !== null) return true
  if (sender.flags.includes('not_addressed_to_project') && !isOwnBccCopy({ senderTrust: sender.trust, senderFlags: sender.flags })) {
    return true
  }
  return sender.flags.includes('stale_date')
}

/** How much the sender asks of the person: see `SENDER_RISK_LEVELS`. A mail with no sender left (settled) asks nothing. */
export function senderRiskLevel(sender: SenderFacts | null): SenderRiskLevel {
  if (!sender) return 'none'
  if (impersonationOf(sender) !== null) return 'impersonation'
  return senderNeedsAcknowledgement(sender) ? 'caution' : 'none'
}

// ------------------------------------------------------------ a member's name

/** The words of a name, as compared: letters only, German spelled out, accents dropped, lower case. */
function nameWords(name: string): string[] {
  return latinize(name.normalize('NFKC'))
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((word) => word.length > 0)
}

/** The fewest words a member's name needs before it is compared at all: „Lena“ alone names half an office's mail. */
const MIN_NAME_WORDS = 2
/** The shortest word of a member's name that counts; an initial („M.“) would match too much. */
const MIN_WORD_LENGTH = 2

/**
 * Whether a From display name claims to be one of the office's members: every
 * word of a member's name (at least two words of two letters) is among the
 * display name's words, in any order, so „Huber, Miriam“, „DI Miriam Huber“
 * and „Miriam Huber (Huber Architektur)“ all claim Miriam Huber.
 *
 * Asked only for a From address that is no member's (a member's own address
 * makes the mail `member_*`). A name the directory only knows as an email
 * address is no name. Errs towards flagging: a member writing from a private
 * address is asked one acknowledgement too many, never one too few.
 *
 * Not a confusables check: a name spelled in look-alike letters of another
 * script is not caught here.
 */
export function claimsMemberName(displayName: string | null, memberNames: Iterable<string>): boolean {
  if (!displayName) return false
  const claimed = new Set(nameWords(displayName))
  if (claimed.size < MIN_NAME_WORDS) return false
  for (const name of memberNames) {
    if (name.includes('@')) continue
    const words = nameWords(name).filter((word) => word.length >= MIN_WORD_LENGTH)
    if (words.length >= MIN_NAME_WORDS && words.every((word) => claimed.has(word))) return true
  }
  return false
}
