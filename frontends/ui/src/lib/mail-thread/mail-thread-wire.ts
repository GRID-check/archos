/**
 * The wire of the E-Mail-Verlauf (ADR-0134): what the `mail-thread-*` routes
 * take and answer, and the shapes of the JSON a filed message carries on its
 * `mail_thread_entries` row. Pure zod, shared by the routes, the agent
 * operations (`lib/agent-api/catalog/mail.ts`), the filing job, the archive
 * import and the „E-Mails“ tab, so each contract is written once.
 *
 * The entry's JSON columns are parsed through these schemas wherever they are
 * read, because the renderer (`./render.ts`) writes what they hold into a
 * document Piloti reads: a row that does not parse is a bug to surface, not
 * text to print.
 */

import { z } from 'zod'
import { SCREENING_DETECTORS } from '@/lib/upload-screening/policy'
import { SENDER_TRUSTS, THREAD_MATCH_HEADERS, THREAD_MATCH_STRENGTHS } from './mail-threading'

const uuid = z.string().uuid()
const isoDateTime = z.string().datetime({ offset: true })

/** Where a filed message came from: the project's address, or a person's Outlook archive (D33). */
export const MAIL_THREAD_ENTRY_SOURCES = ['inbound', 'archive'] as const
export type MailThreadEntrySource = (typeof MAIL_THREAD_ENTRY_SOURCES)[number]

/** How a message was filed: decided in the app, by an outside agent as the person, through a Piloti card, or by a follow. */
export const MAIL_THREAD_FILED_VIA = ['app', 'agent', 'piloti_proposal', 'follow', 'archive_import'] as const
export type MailThreadFiledVia = (typeof MAIL_THREAD_FILED_VIA)[number]

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

/** A follow's length unless the person asks for another, and the most it may run (D31). */
export const MAIL_THREAD_FOLLOW_DEFAULT_DAYS = 60
export const MAIL_THREAD_FOLLOW_MAX_DAYS = 180

/** A thread's bounds (D11): past either, the next message is offered as „Als Fortsetzung ablegen“. */
export const MAIL_THREAD_MAX_ENTRIES = 200
export const MAIL_THREAD_MAX_RENDERED_BYTES = 2 * 1024 * 1024

export const MAIL_THREAD_LIST_LIMIT = 50

// ------------------------------------------------------------ entry columns

/**
 * One address of a filed message (`participants`). The renderer prints the name
 * and the domain, never the address. The project addresses are not
 * participants: the receive job takes them out (B8) before anything is stored.
 */
export const mailThreadParticipantSchema = z.object({
  role: z.enum(['from', 'reply_to', 'to', 'cc']),
  name: z.string().max(300).nullable(),
  address: z.string().min(1).max(320),
})
export type MailThreadParticipant = z.infer<typeof mailThreadParticipantSchema>

/**
 * A span of the own text masked when the person chose „Unkenntlich ablegen“
 * (D13): offsets into `own_text` in UTF-16 code units, as `findSpans` gives
 * them, and the kind whose placeholder replaces it.
 */
export const mailThreadMaskedSpanSchema = z
  .object({
    kind: z.enum([...SCREENING_DETECTORS, 'term']),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((span) => span.end > span.start, { message: 'A masked span ends after it starts' })
export type MailThreadMaskedSpan = z.infer<typeof mailThreadMaskedSpanSchema>

/** One quoted block the reader split off the own text (`quoted`), in the order it appeared. */
export const mailThreadQuoteSchema = z.object({ text: z.string().max(524_288) })
export type MailThreadQuote = z.infer<typeof mailThreadQuoteSchema>

/** One calendar invitation the message carried (`calendar`), as the Python reader gives it, in UTC. */
export const mailThreadCalendarEventSchema = z.object({
  method: z.string().max(40).nullable(),
  summary: z.string().max(500).nullable(),
  start: isoDateTime.nullable(),
  end: isoDateTime.nullable(),
  allDay: z.boolean(),
  location: z.string().max(500).nullable(),
  status: z.string().max(40).nullable(),
})
export type MailThreadCalendarEvent = z.infer<typeof mailThreadCalendarEventSchema>

/**
 * One attachment of the message (`attachment_links`), written once, when the
 * entry is inserted, so the section that names it never changes afterwards
 * (the superset invariant; renaming the attachment's document later does not
 * rewrite the conversation). `documentId` is null for an attachment that was
 * not filed with the message: it is counted, never named.
 *
 * The renderer names an attachment only when both hold (RT-S13): it was filed
 * into a folder at least as visible as the thread document's
 * (`visibleWithThread`, judged by the filing job), and its name passed the
 * Namensprüfung without a release (`nameReleased` false).
 */
export const mailThreadAttachmentLinkSchema = z.object({
  documentId: uuid.nullable(),
  name: z.string().max(400).nullable(),
  folderPath: z.string().max(2000).nullable(),
  visibleWithThread: z.boolean(),
  nameReleased: z.boolean(),
})
export type MailThreadAttachmentLink = z.infer<typeof mailThreadAttachmentLinkSchema>

/** One thread a held mail matched (`inbound_mails.thread_match`): ids and strengths, never names (D9). */
export const threadMatchSchema = z.object({
  threadId: uuid,
  strength: z.enum(THREAD_MATCH_STRENGTHS),
  headers: z.array(z.enum(THREAD_MATCH_HEADERS)).max(THREAD_MATCH_HEADERS.length),
})
export const threadMatchListSchema = z.array(threadMatchSchema).max(50)

// ------------------------------------------------------------ requests

export const mailThreadListQuerySchema = z.object({
  documentId: uuid.optional().describe('Only the thread whose document this is.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAIL_THREAD_LIST_LIMIT)
    .default(MAIL_THREAD_LIST_LIMIT)
    .describe(`Page size (default and most ${MAIL_THREAD_LIST_LIMIT}).`),
  cursor: z.string().min(1).max(200).optional().describe('The previous `nextCursor`.'),
})
export type MailThreadListQuery = z.infer<typeof mailThreadListQuerySchema>

export const mailThreadFollowBodySchema = z
  .object({
    days: z
      .number()
      .int()
      .min(1)
      .max(MAIL_THREAD_FOLLOW_MAX_DAYS)
      .optional()
      .describe(
        `How long the follow holds, in days (default ${MAIL_THREAD_FOLLOW_DEFAULT_DAYS}). Calling again renews it. ` +
          'While it holds, a later reply from a verified domain already in the thread has its text appended as you; ' +
          'attachments always wait for review.'
      ),
  })
  .strict()
export type MailThreadFollowBody = z.infer<typeof mailThreadFollowBodySchema>

export const mailThreadUnfollowQuerySchema = z.object({
  userId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Whose follow to end; your own when omitted. Ending someone else's needs project:manage."),
})
export type MailThreadUnfollowQuery = z.infer<typeof mailThreadUnfollowQuerySchema>

const detachTargetSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('append'),
      mailThreadId: uuid.describe('The thread to move the message into; mail-thread-list names them.'),
    })
    .strict(),
  z
    .object({
      action: z.literal('create'),
      folderId: uuid.nullable().describe('The folder of the new thread document, or null with newFolderPath.'),
      newFolderPath: z.string().min(1).max(1000).nullable().describe('A folder path to create, or null.'),
      name: z.string().min(1).max(240).describe('The new thread document name. It is name-screened.'),
      screeningRelease: z
        .literal('name')
        .optional()
        .describe('File under a name the name check stopped; audited as an override.'),
    })
    .strict(),
])

export const mailThreadEntryDetachBodySchema = z
  .object({
    target: detachTargetSchema.describe(
      'Where the message goes. The source thread gets a new Fassung without it; earlier Fassungen keep it.'
    ),
  })
  .strict()
export type MailThreadEntryDetachBody = z.infer<typeof mailThreadEntryDetachBodySchema>

// ------------------------------------------------------------ views

/** A follow as the thread view shows it. */
export interface MailThreadFollowView {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
  renewedAt: string | null
  dailyCap: number
}

/** An attachment of an entry, only when the viewer may open its document. */
export interface MailThreadAttachmentView {
  documentId: string
  name: string
}

/** One filed message. */
export interface MailThreadEntryView {
  id: string
  /** The section heading, as the thread document cites it; never changes. */
  heading: string
  source: MailThreadEntrySource
  senderName: string | null
  senderDomain: string | null
  signerDomain: string | null
  senderTrust: (typeof SENDER_TRUSTS)[number]
  sentAt: string
  receivedAt: string
  /** The Fassung the message first appeared in. */
  firstVersion: { id: string; number: number } | null
  /** Whether a kept original exists (inbound entries), and whether it may be downloaded now. */
  original: { scanStatus: 'pending' | 'clean' | 'infected' | 'failed' } | null
  attachments: MailThreadAttachmentView[]
  filedBy: string
  filedVia: MailThreadFiledVia
  filedAt: string
}

/** A thread in a list. */
export interface MailThreadSummaryView {
  id: string
  documentId: string
  name: string
  entryCount: number
  lastEntryAt: string | null
  /** Whether the viewer follows it. */
  followed: boolean
}

/** One thread with its messages (`mail-thread-get`). */
export interface MailThreadView extends MailThreadSummaryView {
  participantDomains: string[]
  continuesThreadId: string | null
  entries: MailThreadEntryView[]
  follows: MailThreadFollowView[]
  /** Mails waiting in the E-Mail-Eingang that matched this thread; null unless the viewer may file. */
  waitingCount: number | null
}

export interface MailThreadListView {
  items: MailThreadSummaryView[]
  nextCursor: string | null
}
