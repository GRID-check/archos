/**
 * The vocabulary of the E-Mail-Verlauf (ADR-0134, migration 0184), free of
 * drizzle and of zod: the tuples the `mail_thread*` tables CHECK, their bounds,
 * and the shapes of the JSON a filed message carries.
 *
 * `db/schema/mail-thread.ts` types its columns from here, and
 * `./mail-thread-wire.ts` holds the zod schemas that parse the same JSON where
 * it is read, so the database, the renderer and the routes name one shape.
 * A value added here is a CHECK changed in a migration.
 *
 * Pure: no database, no `server-only`, no service (`wire-modules.spec.ts`).
 */

import type { Locale } from '@/i18n/config'
import type { ScreeningDetector } from '@/lib/upload-screening/policy'
import type { MailParticipant } from '@/lib/inbound-mail/inbound-mail-vocabulary'

// ------------------------------------------------------------ threads

/**
 * The locales a thread renders in. A thread is rendered in one locale for its
 * whole life (`mail_threads.locale`, fixed at creation): Fassung N+1 repeats
 * every section of Fassung N byte for byte, which a second locale would break.
 */
export const MAIL_THREAD_LOCALES = ['de', 'en'] as const satisfies readonly Locale[]
export type MailThreadLocale = (typeof MAIL_THREAD_LOCALES)[number]

/** A thread's bounds (D11): past either, the next message is offered as „Als Fortsetzung ablegen“. */
export const MAIL_THREAD_MAX_ENTRIES = 200
export const MAIL_THREAD_MAX_RENDERED_BYTES = 2 * 1024 * 1024

// ------------------------------------------------------------ matching

/**
 * How strongly a mail matched a thread, strongest first (D11; the ladder and
 * what each rung means are `./mail-threading.ts`).
 */
export const THREAD_MATCH_STRENGTHS = ['reference', 'thread_index', 'reference_subject_changed', 'subject'] as const
export type ThreadMatchStrength = (typeof THREAD_MATCH_STRENGTHS)[number]

/** The headers a match can rest on, lower-case as mailauth lists signed headers. */
export const THREAD_MATCH_HEADERS = ['in-reply-to', 'references', 'thread-index', 'subject'] as const
export type ThreadMatchHeader = (typeof THREAD_MATCH_HEADERS)[number]

/** One thread a held mail matched (`inbound_mails.thread_match`): ids and strengths, never names (D9). */
export interface ThreadMatch {
  threadId: string
  strength: ThreadMatchStrength
  headers: ThreadMatchHeader[]
}

/**
 * Whether a thread received a Message-ID (an entry of it is that message) or
 * only knows it as a reference one of its entries named
 * (`mail_thread_message_ids.state`).
 */
export const MAIL_THREAD_MESSAGE_ID_STATES = ['received', 'referenced'] as const
export type MailThreadMessageIdState = (typeof MAIL_THREAD_MESSAGE_ID_STATES)[number]

// ------------------------------------------------------------ entries

/** Where a filed message came from: the project's address, or a person's Outlook archive (D33). */
export const MAIL_THREAD_ENTRY_SOURCES = ['inbound', 'archive'] as const
export type MailThreadEntrySource = (typeof MAIL_THREAD_ENTRY_SOURCES)[number]

/**
 * How a message was filed: decided in the app, by an outside agent as the
 * person, through a Piloti card, by a follow, or by the person's archive import.
 * An archive entry is always `archive_import`, and only an archive entry is.
 */
export const MAIL_THREAD_FILED_VIA = ['app', 'agent', 'piloti_proposal', 'follow', 'archive_import'] as const
export type MailThreadFiledVia = (typeof MAIL_THREAD_FILED_VIA)[number]

/** One address of a filed message (`mail_thread_entries.participants`); the renderer prints name and domain only. */
export type MailThreadParticipant = MailParticipant

/**
 * A span of the own text masked when the person chose „Unkenntlich ablegen“
 * (D13): UTF-16 offsets into `own_text`, as `findSpans` gives them, and the
 * kind whose placeholder replaces it.
 */
export interface MailThreadMaskedSpan {
  kind: ScreeningDetector | 'term'
  start: number
  end: number
}

/** One quoted block the reader split off the own text, in the order it appeared. */
export interface MailThreadQuote {
  text: string
}

/** One calendar invitation the message carried, as the Python reader gives it, times in ISO 8601 UTC. */
export interface MailThreadCalendarEvent {
  method: string | null
  summary: string | null
  start: string | null
  end: string | null
  allDay: boolean
  location: string | null
  status: string | null
}

/**
 * One attachment of the message, **frozen when the entry is inserted**, names
 * included: the section that names it may never change afterwards (the
 * superset invariant), so a later rename of the attachment's document does not
 * rewrite the conversation. `documentId` is null for an attachment that was
 * not filed: it is counted, never named.
 *
 * The renderer names an attachment only when it was filed into a folder at
 * least as visible as the thread document's (`visibleWithThread`) and its name
 * passed the Namensprüfung without a release (`nameReleased` false), RT-S13.
 */
export interface MailThreadAttachmentLink {
  documentId: string | null
  name: string | null
  folderPath: string | null
  visibleWithThread: boolean
  nameReleased: boolean
}

/** The most own text one entry keeps, in UTF-8 bytes; the rest is in the original. */
export const MAIL_THREAD_ENTRY_MAX_TEXT_BYTES = 512 * 1024

// ------------------------------------------------------------ follows

/** Why a follow ended (`mail_thread_follows.ended_reason`, D31). */
export const MAIL_THREAD_FOLLOW_END_REASONS = [
  'unfollowed',
  'expired',
  'access_lost',
  'address_rotated',
  'detached',
  'document_gone',
  'revoked_by_manager',
] as const
export type MailThreadFollowEndReason = (typeof MAIL_THREAD_FOLLOW_END_REASONS)[number]

/** The reasons a person gives by acting; every other reason is the system noticing. */
export const MAIL_THREAD_FOLLOW_PERSON_END_REASONS = [
  'unfollowed',
  'revoked_by_manager',
] as const satisfies readonly MailThreadFollowEndReason[]

/** A follow's length unless the person asks for another, and the most it may run from its start (D31). */
export const MAIL_THREAD_FOLLOW_DEFAULT_DAYS = 60
export const MAIL_THREAD_FOLLOW_MAX_DAYS = 180

/** Appends one follow makes per day by default, and the most a follow may allow. */
export const MAIL_THREAD_FOLLOW_DEFAULT_DAILY_CAP = 20
export const MAIL_THREAD_FOLLOW_MAX_DAILY_CAP = 50
