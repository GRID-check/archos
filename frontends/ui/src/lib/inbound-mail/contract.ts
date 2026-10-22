/**
 * The transport contract of project mail (ADR-0134, ADR-0135): what the
 * Cloudflare Email Worker and the webhook agree on, and the closed vocabularies
 * the transport modules of this folder produce.
 *
 * Pure and client-safe: no `server-only`, no database, no parser. The webhook,
 * the receive job, the drizzle schema (through `./inbound-mail-vocabulary`),
 * the wire module and the review UI all read the same tuples from here, and the
 * Worker, which is plain JavaScript outside this package, is held to the same
 * values by `shared/inbound-mail-contract.json` (`contract.spec.ts` here,
 * `inbound-mail-worker.spec.ts` there).
 *
 * Every token is English; what a person reads for one lives in the i18n
 * dictionaries.
 */

import type { SenderTrust } from '@/lib/mail-thread/mail-threading'

// ---------------------------------------------------------------------------
// The Worker ↔ webhook contract
// ---------------------------------------------------------------------------

/**
 * Where the Worker posts. Under `/api/internal/signed/`, which the Next proxy
 * does not match, so the body is never buffered before its signature is
 * checked (ADR-0134 D20).
 */
export const INBOUND_MAIL_WEBHOOK_PATH = '/api/internal/signed/inbound-mail'

/** The envelope recipient (RFC 5321 RCPT TO) the Worker was invoked for. */
export const ENVELOPE_TO_HEADER = 'x-envelope-to'

/** The envelope sender (RFC 5321 MAIL FROM), empty for a null reverse-path. */
export const ENVELOPE_FROM_HEADER = 'x-envelope-from'

/**
 * The Worker bounces a mail ONLY when the answer is a 4xx carrying
 * `x-inbound-verdict: reject`. Any other answer, a 4xx without it included,
 * makes it throw so the sending server retries: a misrouted URL, a proxy's 404
 * or a paused deployment can never bounce a member's mail.
 */
export const VERDICT_HEADER = 'x-inbound-verdict'
export const VERDICT_REJECT = 'reject'

/**
 * The largest message the webhook accepts, 26 MiB. The Worker can buffer
 * 25 MiB at most (Workers Paid), so the bound is never what refuses a mail
 * Cloudflare delivered; it is what the database's `raw_size_bytes` CHECK and
 * the Envoy per-route limit (27 MiB, above it) are written against.
 */
export const MAX_RAW_MESSAGE_BYTES = 26 * 1024 * 1024

/**
 * The RFC 9421 components the Worker signs, in order: the request line, the
 * RFC 9530 digest and length of the fixed-length body, and both envelope
 * headers, so a replayed signature cannot be pointed at another project.
 */
export const SIGNED_COMPONENTS = [
  '@method',
  '@target-uri',
  'content-digest',
  'content-length',
  ENVELOPE_TO_HEADER,
  ENVELOPE_FROM_HEADER,
] as const

/** `expires − created` of every signature, in seconds. */
export const SIGNATURE_LIFETIME_SECONDS = 300

/**
 * The one bounce text, ASCII, naming no reason: an unknown token, a deleted
 * project and an office that switched the feature off read the same, so a
 * bounce teaches a guesser nothing (ADR-0134 D5).
 */
export const REJECT_TEXT =
  'This message could not be delivered: the address is unknown or no longer valid. ' +
  'Help: https://piloti.at/e-mail-eingang/ Privacy: https://piloti.at/datenschutz/'

/** What the Worker does with the webhook's answer. */
export type DeliveryOutcome = 'accepted' | 'rejected' | 'retry'

/** The Worker's reading of an answer, written once so both sides run the same cases. */
export function deliveryOutcome(status: number, verdict: string | null): DeliveryOutcome {
  if (status >= 200 && status < 300) return 'accepted'
  if (status >= 400 && status < 500 && verdict === VERDICT_REJECT) return 'rejected'
  return 'retry'
}

// ---------------------------------------------------------------------------
// The vocabularies the transport modules produce
// ---------------------------------------------------------------------------

/**
 * Who a mail at the project's address is from, as far as the bytes and DNS can
 * tell (`./sender-auth`, `inbound_mails.sender_trust`). `verified` is an
 * aligned DKIM pass that also meets our hygiene rules; `member` is a From
 * address equal to a directory member's address. DKIM proves a domain, never a
 * person, which is why no label claims more than the domain.
 *
 * The thread core's `SenderTrust` adds `not_checked`, an archive entry's; this
 * is its four inbound values, held to it by the type.
 */
export const INBOUND_SENDER_TRUSTS = [
  'member_verified',
  'member_unverified',
  'external_verified',
  'external_unverified',
] as const satisfies readonly SenderTrust[]
export type InboundSenderTrust = (typeof INBOUND_SENDER_TRUSTS)[number]

/**
 * Why the sender is or is not verified, one code per mail (`sender_reason`).
 * `dkim_pass` is the only verified one. The others are ordered as
 * `./sender-auth` ranks them when several signatures disagree: the most
 * specific explanation first.
 */
export const SENDER_REASONS = [
  'dkim_pass',
  // The raw header block (checked before any signature, against parser differentials).
  'header_malformed',
  'header_duplicate',
  'from_count',
  'from_not_ascii',
  'dkim_too_many',
  // An aligned signature that verified but breaks a hygiene rule.
  'dkim_body_length',
  'dkim_testing',
  'dkim_expired',
  'dkim_unsigned_fields',
  'dkim_weak_algorithm',
  'dkim_short_key',
  // An aligned signature that did not verify.
  'dkim_temperror',
  'dkim_fail',
  'dkim_policy',
  'dkim_permerror',
  // No aligned signature at all.
  'dkim_unaligned',
  'dkim_none',
  // The verifier itself.
  'verifier_timeout',
  'verifier_error',
] as const
export type SenderReason = (typeof SENDER_REASONS)[number]

/**
 * Facts about one mail's sender that shape defaults (`sender_flags`). The
 * first four come from `./sender-auth`; `message_id_reused` and
 * `already_filed` from the receive job's Message-ID lookup.
 *
 * - `not_addressed_to_project`: a verified mail whose signed To and Cc do not
 *   name the project's address: a member's mail to someone else, replayed.
 * - `bcc_own`: set TOGETHER with `not_addressed_to_project` when the mail is
 *   `member_verified` with a signed Date within a day of receipt: the
 *   member's own Bcc copy. The pair errs safe: whoever forgets the exception
 *   asks for one acknowledgement too many and never offers a follow it should not.
 * - `stale_date`: the signed Date is more than seven days before receipt.
 * - `date_out_of_range`: the Date is missing or outside the clamp window, and
 *   the receipt time stands in for it.
 */
export const SENDER_FLAGS = [
  'not_addressed_to_project',
  'bcc_own',
  'stale_date',
  'date_out_of_range',
  'message_id_reused',
  'already_filed',
] as const
export type SenderFlag = (typeof SENDER_FLAGS)[number]

/**
 * Facts about one attachment (`risk_flags`). `./mime` sets `macro`,
 * `type_mismatch`, `encrypted`, `forwarded_inner` and `type_not_accepted`;
 * the receive job and the decision set the rest.
 */
export const PART_RISK_FLAGS = [
  'macro',
  'type_mismatch',
  'encrypted',
  'name_stop',
  'duplicate_of',
  'forwarded_inner',
  'unreadable',
  'unverified_thread',
  'type_not_accepted',
] as const
export type PartRiskFlag = (typeof PART_RISK_FLAGS)[number]

/**
 * Why a MIME part was not staged as a part a person decides on (`./mime`).
 * Every one of them is still in the original `.eml`.
 */
export const NOT_STAGED_REASONS = [
  /** Part of the message's own layout: a `cid:` image, an auto-named pasted image, a tracking pixel. */
  'embedded',
  /** An S/MIME or PGP signature. */
  'signature',
  /** `winmail.dat`: Outlook's own container, not a file anybody sent. */
  'tnef',
  /** S/MIME or PGP encryption: nothing in it is readable here. */
  'encrypted',
  /** A calendar invitation; the Python reader renders it into the text. */
  'calendar',
  /** No bytes. */
  'empty',
  /** An archive the office does not accept as a file; it is never expanded. */
  'archive',
  /** Larger than one part may be. */
  'size',
  /** Past the number of parts one mail may stage, or a forward nested too deep. */
  'limit',
] as const
export type NotStagedReason = (typeof NOT_STAGED_REASONS)[number]

/** Why a mail was accepted and then dropped unseen (`./automatic-mail`, `dropped_reason`). */
export const DROPPED_REASONS = ['auto_reply', 'delivery_report', 'self_loop'] as const
export type DroppedReason = (typeof DROPPED_REASONS)[number]
