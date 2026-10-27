import 'server-only'
/**
 * An Outlook archive's mails become entries of the project's E-Mail-Verläufe
 * (ADR-0085 as amended, ADR-0134, DECISION D33), the same Verläufe mail to the
 * project's address is filed into: one shape for mail, whichever way it came.
 * Called by the archive import (`lib/mail-import/filing.ts`, `job.ts`) as the
 * person who started it. Importing one's own archive is itself the decision,
 * so nothing here waits in the E-Mail-Eingang.
 *
 * Per mail ({@link appendArchiveEntry}), after its attachments are filed:
 *
 * 1. **Dedupe by Message-ID.** An entry of the project that received the same
 *    id, from the address or from any archive, means the text is in a Verlauf
 *    already: it is skipped and counted (`already_in_project`). Its
 *    attachments were filed by the import's own rules all the same. The other
 *    way round is the receive job's: an inbound mail whose id an archive entry
 *    holds is flagged `already_filed`.
 * 2. **Match, strictly.** The ladder is `./mail-threading.ts`'s, but the
 *    import appends only on `reference` or `thread_index`, each with an equal
 *    base subject, or when a Verlauf already cites this very message (an
 *    archive is walked folder by folder, so a reply is often filed before
 *    what it answers). A subject alone never joins a conversation: nobody
 *    looks at the import's choices before they are filed.
 * 3. **Only into a Verlauf the person may write**: its document live and
 *    readable for them and its folder writable (`requireFolderWrite`'s rule),
 *    with room for one more message (200, 2 MiB). Otherwise the next match,
 *    or a new archive Verlauf in the archive's folder, named
 *    `{Gegenüber} {yyyy-mm-dd}` when it is first rendered.
 * 4. **The entry is written at once, the Fassung at the slice's end.** Under
 *    the thread's render lease (`./write-repository.ts`), so its heading is
 *    made against every heading the thread has and no Fassung is rendered
 *    from a half-written set: the entry, its Message-IDs and one row per
 *    attachment (D36) in one transaction, and the Verlauf marked as owing a
 *    Fassung (`render_pending_at`).
 *
 * Per slice ({@link renderPendingThreads}): each Verlauf the import touched is
 * rendered ONCE (`./render.ts`) and uploaded through the ordinary upload path
 * as the person (`uploadThreadVersion`), into the import's Verlauf batch with
 * the archive effects (D35). A 50-message conversation is one Fassung, not 50
 * Fassungen and 50 ingests. The superset invariant holds because an entry
 * only ever joins a set, and the lease keeps two writers from rendering side
 * by side.
 *
 * **Retry-safe.** An entry's id and the id of a Verlauf it opens are the
 * import's and the mail's (uuid5), so a retried mail finds its own entry and
 * changes nothing; a Fassung whose answer was lost is found by its digest.
 *
 * **What an archive entry says** (RT-S2): `sender_trust = 'not_checked'`; its
 * heading names the From domain „aus dem Outlook-Archiv“, never a signer; it
 * has no original (the import never had the message's bytes) and no Bcc. The
 * body is the text the archive reader chose (plain, else HTML, else RTF); the
 * quotes in it are not split off, so an archive section keeps the history its
 * mail quoted.
 */

import { v5 as uuidv5 } from 'uuid'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canWriteFolder } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import type { AccessFolder } from '@/lib/authz/folder-access-rule'
import type {
  MailImport,
  MailImportSkipReason,
  MailThreadEntryRow,
  MailThreadRow,
  NewMailThreadEntryAttachmentRow,
  NewMailThreadEntryRow,
} from '@/lib/db/schema'
import { memberReader } from '@/lib/documents/document-reader'
import type { InboundMailFilingFailure } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { findThreadCandidates } from '@/lib/inbound-mail/repository'
import type { ArchiveMail } from '@/lib/mail-import/archive-client'
import { archiveThreadName, numbered, type MailAddress } from '@/lib/mail-import/naming'
import {
  answeredEntryOf,
  cutToBytes,
  readableWithThread,
  RENDER_LEASE_MS,
  RENDER_LEASE_RETRY_MS,
  renderEntriesOf,
  renderEntryOf,
  threadDocumentFilename,
  threadTitleOf,
  uploadThreadVersion,
} from './append'
import {
  commitArchiveEntry,
  commitArchiveRender,
  findArchiveEntry,
  findEntryWithMessageId,
  findPendingThreadsOfImport,
  giveUpPendingRender,
  importWroteInto,
  threadHoldingDocument,
} from './archive-repository'
import { mailThreadIngestFacts } from './ingest-facts'
import {
  baseSubject,
  clampSentAt,
  domainOf,
  matchThread,
  normalizeMessageId,
  parseInReplyTo,
  parseReferences,
  PRESELECTABLE_STRENGTHS,
  threadIndexGuid,
  type ThreadCandidate,
  type ThreadingMessage,
} from './mail-threading'
import type { MailThreadAttachmentNotFiledReason, MailThreadParticipant } from './mail-thread-wire'
import {
  MAIL_THREAD_ENTRY_MAX_TEXT_BYTES,
  MAIL_THREAD_MAX_ENTRIES,
  MAIL_THREAD_MAX_RENDERED_BYTES,
  type MailThreadLocale,
} from './mail-thread-vocabulary'
import { mailThreadEntryHeading, renderMailThread, sectionAttachment } from './render'
import { MAIL_THREAD_RENDER_COPY } from './render-copy'
import {
  acquireRenderLease,
  findCurrentVersions,
  findThreadEntryRows,
  findThreadRow,
  findWritableThread,
  releaseRenderLease,
} from './write-repository'

/** The namespace an archived mail's entry and the Verlauf it opens are derived in. Fixed: changing it breaks retries. */
const ARCHIVE_NAMESPACE = '8c2f4e1a-6b3d-4f5e-a7c9-0d1e2f3a4b5c'

/** The entry an archived mail becomes: the same id on every retry of the mail. */
export const archiveEntryIdOf = (importId: string, position: number): string =>
  uuidv5(`entry:${importId}:${position}`, ARCHIVE_NAMESPACE)

/** The Verlauf an archived mail opens, when it opens one: the same id on every retry. */
export const archiveThreadIdOf = (importId: string, position: number): string =>
  uuidv5(`thread:${importId}:${position}`, ARCHIVE_NAMESPACE)

/** Names tried for a Verlauf the import opens before it gives up: `X 2025-03-12`, `X 2025-03-12 (2)`… */
const MAX_THREAD_NAME_ATTEMPTS = 50

/** Room a rendition keeps under the 2 MiB cap for what the size check cannot know yet (the Verlauf's own name). */
const RENDERED_BYTES_MARGIN = 1024

/** A stand-in title as long as any name a Verlauf gets, for the size check before it is named. */
const LONGEST_TITLE = 'x'.repeat(260)

/** How often a mail asks again for a lease another writer holds, before its slice ends and comes back. */
const LEASE_POLL_MS = 1_000

// ---------------------------------------------------------------------------
// The mail, as the thread tables read it (pure)
// ---------------------------------------------------------------------------

/** An archived mail in the shape its entry and the matching ladder read. */
export interface ArchiveMessage {
  messageId: string | null
  inReplyTo: string[]
  references: string[]
  threadIndexGuid: string | null
  baseSubject: string
  sender: MailAddress | null
  /** From, To and Cc, in that order; never Bcc. At most 50, as the entry keeps them. */
  participants: MailThreadParticipant[]
  sentAt: Date
  receivedAt: Date
  ownText: string
}

function dateOf(value: string | null): Date | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

const cut = (value: string | null | undefined, max: number): string | null => (value ? value.slice(0, max) : null)

/**
 * The mail's ids, subject, parties and times as the Verlauf keeps them. The
 * receipt time is the mail's own, else its send time (a sent item), else the
 * import's start: an entry needs one, and a mail without a date is still mail.
 */
export function archiveMessageOf(mail: ArchiveMail, importedAt: Date): ArchiveMessage {
  const sent = dateOf(mail.sent_at)
  const receivedAt = dateOf(mail.received_at) ?? sent ?? importedAt
  const participants: MailThreadParticipant[] = []
  const add = (role: MailThreadParticipant['role'], address: MailAddress) => {
    const clean = address.address.trim()
    if (!clean) return
    participants.push({ role, name: cut(address.name.trim() || null, 300), address: clean.slice(0, 320) })
  }
  if (mail.sender) add('from', mail.sender)
  for (const address of mail.to) add('to', address)
  for (const address of mail.cc) add('cc', address)
  return {
    messageId: normalizeMessageId(mail.message_id),
    inReplyTo: parseInReplyTo(mail.in_reply_to),
    references: parseReferences(mail.references),
    threadIndexGuid: threadIndexGuid(mail.conversation_index),
    baseSubject: baseSubject(mail.subject),
    sender: mail.sender,
    participants: participants.slice(0, 50),
    sentAt: sent ?? receivedAt,
    receivedAt,
    ownText: cutToBytes(mail.body.text, MAIL_THREAD_ENTRY_MAX_TEXT_BYTES),
  }
}

/** What the matching ladder reads of an archived mail. */
export function threadingMessageOf(message: ArchiveMessage): ThreadingMessage {
  return {
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    threadIndexGuid: message.threadIndexGuid,
    baseSubject: message.baseSubject,
    participants: [...new Set(message.participants.map((participant) => participant.address.toLowerCase()))],
    sentAt: clampSentAt(message.sentAt, message.receivedAt).sentAt,
  }
}

/**
 * The Verläufe an archived mail may join, best first (D33): a strong rung of
 * the ladder (`reference`, `thread_index`, each with an equal base subject),
 * then a Verlauf that cites this very message under the same subject (the
 * reply was walked before what it answers). Nothing on a subject alone.
 */
export function archiveThreadMatches(message: ArchiveMessage, candidates: readonly ThreadCandidate[]): string[] {
  const strong = matchThread(threadingMessageOf(message), candidates)
    .filter((match) => PRESELECTABLE_STRENGTHS.includes(match.strength))
    .map((match) => match.threadId)
  const own = message.messageId
  const citing = own
    ? candidates
        .filter((thread) => thread.baseSubject === message.baseSubject && message.baseSubject !== '')
        .filter((thread) => thread.referencedIds.includes(own))
        .sort((a, b) => (b.lastEntryAt?.getTime() ?? 0) - (a.lastEntryAt?.getTime() ?? 0))
        .map((thread) => thread.threadId)
    : []
  return [...new Set([...strong, ...citing])]
}

/**
 * The conversation's other party, from the importer's side („Gegenüber“, D33):
 * the first recipient of a mail they sent, else the sender. A sent item is a
 * mail From the person who started the import.
 */
export function counterpartOf(
  entry: Pick<MailThreadEntryRow, 'senderAddress' | 'senderName' | 'participants'>,
  importerEmail: string | null
): MailAddress | null {
  const own = importerEmail?.trim().toLowerCase()
  const sentByImporter = Boolean(own) && entry.senderAddress?.toLowerCase() === own
  if (sentByImporter) {
    const recipient =
      entry.participants.find((participant) => participant.role === 'to') ??
      entry.participants.find((participant) => participant.role === 'cc')
    if (recipient) return { name: recipient.name ?? '', address: recipient.address }
  }
  if (!entry.senderAddress && !entry.senderName) return null
  return { name: entry.senderName ?? '', address: entry.senderAddress ?? '' }
}

/** The entry row an archived mail becomes, before its heading. Pure. */
export function archiveEntryOf(input: {
  id: string
  threadId: string
  mailImport: Pick<MailImport, 'id' | 'organizationId' | 'projectId' | 'userId'>
  message: ArchiveMessage
  heading: string
  inReplyToEntryId: string | null
  filedAt: Date
}): NewMailThreadEntryRow {
  const { message, mailImport } = input
  return {
    id: input.id,
    organizationId: mailImport.organizationId,
    projectId: mailImport.projectId,
    threadId: input.threadId,
    source: 'archive',
    inboundMailId: null,
    mailImportId: mailImport.id,
    messageId: message.messageId,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    heading: input.heading,
    inReplyToEntryId: input.inReplyToEntryId,
    senderAddress: cut(message.sender?.address.trim(), 320),
    senderName: cut(message.sender?.name.trim(), 300),
    senderDomain: domainOf(message.sender?.address),
    signerDomain: null,
    senderTrust: 'not_checked',
    authenticationResults: null,
    participants: message.participants,
    ownText: message.ownText,
    maskedSpans: null,
    quoted: [],
    calendar: [],
    firstVersionId: null,
    filedBy: mailImport.userId,
    filedVia: 'archive_import',
    filedAt: input.filedAt,
  }
}

// ---------------------------------------------------------------------------
// What came with the mail (D36, pure)
// ---------------------------------------------------------------------------

/** The import's skip reasons as the attachment rows name them; an attached mail is unreadable here. */
export const NOT_FILED_REASON_OF_SKIP: Readonly<Record<MailImportSkipReason, MailThreadAttachmentNotFiledReason>> = {
  embedded_message: 'unreadable',
  type: 'type_not_accepted',
  size: 'size',
  unreadable: 'unreadable',
  screened: 'screened',
  access: 'access',
  name_taken: 'name_taken',
}

/** What became of one attachment of an archived mail (`lib/mail-import/filing.ts`). Inline pictures have none. */
export type ArchiveAttachmentOutcome =
  | {
      index: number
      /** The name the attachment came with. */
      filename: string
      filed: true
      documentId: string
      /** The name it was filed under (`<mail folder> – <name>`). */
      documentName: string
      folderId: string
    }
  | { index: number; filename: string; filed: false; reason: MailImportSkipReason }

/**
 * One row per attachment of the mail, whatever became of it (D36), with what
 * its section prints frozen in. Pure. A filed attachment is named only when
 * everyone who reads the Verlauf may read the folder it went into, and never
 * when the name check stopped it (it is then not filed at all, ADR-0086).
 */
export function archiveAttachmentRowsOf(input: {
  entryId: string
  organizationId: string
  projectId: string
  outcomes: readonly ArchiveAttachmentOutcome[]
  /** The newest Fassung of each filed document, as the importer reads it; absent when it is gone. */
  versions: ReadonlyMap<string, string>
  /** The folder path of each folder an attachment went into. */
  folderPaths: ReadonlyMap<string, string>
  visibleWithThread: (folderId: string) => boolean
}): NewMailThreadEntryAttachmentRow[] {
  const base = { organizationId: input.organizationId, projectId: input.projectId, entryId: input.entryId }
  return input.outcomes.map((outcome) => {
    const filename = cut(outcome.filename.trim() || null, 500)
    if (!outcome.filed) {
      return {
        ...base,
        position: outcome.index,
        filename,
        disposition: 'not_filed',
        notFiledReason: NOT_FILED_REASON_OF_SKIP[outcome.reason],
      }
    }
    const versionId = input.versions.get(outcome.documentId) ?? null
    const section = sectionAttachment({
      disposition: 'filed',
      name: outcome.documentName,
      folderPath: input.folderPaths.get(outcome.folderId) ?? null,
      visibleWithThread: versionId !== null && input.visibleWithThread(outcome.folderId),
      nameReleased: false,
    })
    return {
      ...base,
      position: outcome.index,
      filename,
      disposition: 'filed',
      notFiledReason: null,
      documentId: versionId ? outcome.documentId : null,
      documentVersionId: versionId,
      sectionName: section.name,
      sectionFolderPath: section.folderPath,
    }
  })
}

// ---------------------------------------------------------------------------
// Filing one mail's text
// ---------------------------------------------------------------------------

/** What every mail of a slice files its text with. */
export interface ArchiveFiling {
  session: AuthorizedSession
  mailImport: Pick<MailImport, 'id' | 'organizationId' | 'projectId' | 'userId' | 'userEmail' | 'createdAt'>
  /** `E-Mail-Import/<archive>`: where a Verlauf the import opens goes. */
  archiveFolderId: string
  /** The slice's render-lease holder (a uuid), so a retry of the slice's own write is the same writer. */
  holder: string
  /** The locale a Verlauf the import opens renders in (`newThreadLocaleFor`). */
  locale: MailThreadLocale
  /** The project's folders, for whether an attachment may be named beside the Verlauf; reloaded when it lacks one. */
  folderTree: FolderTree
  request: Request
}

/** What became of an archived mail's text. */
export type ArchiveEntryOutcome =
  | { kind: 'already_in_project' }
  | {
      kind: 'filed'
      threadId: string
      /** The mail opened this Verlauf. */
      threadCreated: boolean
      /** The import's first mail into a Verlauf it did not open. */
      threadJoined: boolean
    }
  /** Another writer holds the Verlauf the mail belongs in: its slice ends and comes back. */
  | { kind: 'busy' }

/** The project's folder tree for one slice, read again when a folder made since is asked about. */
export class FolderTree {
  private tree: ReadonlyMap<string, AccessFolder> | null = null

  constructor(
    private readonly organizationId: string,
    private readonly projectId: string
  ) {}

  async covering(folderIds: readonly (string | null)[]): Promise<ReadonlyMap<string, AccessFolder>> {
    const wanted = folderIds.filter((id): id is string => id !== null)
    if (!this.tree || wanted.some((id) => !this.tree!.has(id))) {
      const folders = await listProjectFolderTree(this.organizationId, this.projectId)
      this.tree = new Map(folders.map((folder): [string, AccessFolder] => [folder.id, folder]))
    }
    return this.tree
  }
}

/** The mail's folder as its attachments went into it; null when it has none (no attachment to file). */
export interface ArchiveMailFolder {
  id: string
  path: string
}

/**
 * File an archived mail's text into its Verlauf (the module header's steps 1
 * to 4), after its attachments: their outcomes are what its rows record.
 */
export async function appendArchiveEntry(
  filing: ArchiveFiling,
  mail: ArchiveMail,
  attachments: { outcomes: readonly ArchiveAttachmentOutcome[]; folder: ArchiveMailFolder | null }
): Promise<ArchiveEntryOutcome> {
  const { mailImport } = filing
  const entryId = archiveEntryIdOf(mailImport.id, mail.position)
  const createdThreadId = archiveThreadIdOf(mailImport.id, mail.position)

  const own = await findArchiveEntry(mailImport.projectId, entryId)
  if (own) return filedOutcome(filing, own.threadId, createdThreadId, entryId)

  const message = archiveMessageOf(mail, new Date(mailImport.createdAt))
  if (message.messageId && (await findEntryWithMessageId(mailImport.projectId, message.messageId, entryId))) {
    return { kind: 'already_in_project' }
  }

  const candidates = await findThreadCandidates(
    mailImport.projectId,
    {
      messageIds: [message.messageId, ...message.inReplyTo, ...message.references].filter(
        (id): id is string => id !== null
      ),
      threadIndexGuid: message.threadIndexGuid,
      baseSubject: message.baseSubject,
      participants: threadingMessageOf(message).participants,
    },
    { pendingOfImport: mailImport.id }
  )
  for (const threadId of archiveThreadMatches(message, candidates)) {
    const joined = await joinThread(filing, threadId, { entryId, message, attachments })
    if (joined === 'busy') return { kind: 'busy' }
    if (joined === 'committed') return filedOutcome(filing, threadId, createdThreadId, entryId)
  }

  await commitEntry(filing, {
    threadId: createdThreadId,
    newThread: true,
    threadFolderId: filing.archiveFolderId,
    earlier: [],
    entryId,
    message,
    attachments,
  })
  return filedOutcome(filing, createdThreadId, createdThreadId, entryId)
}

async function filedOutcome(
  filing: ArchiveFiling,
  threadId: string,
  createdThreadId: string,
  entryId: string
): Promise<ArchiveEntryOutcome> {
  const threadCreated = threadId === createdThreadId
  const threadJoined = !threadCreated && !(await importWroteInto(threadId, filing.mailImport.id, entryId))
  return { kind: 'filed', threadId, threadCreated, threadJoined }
}

interface PendingEntry {
  entryId: string
  message: ArchiveMessage
  attachments: { outcomes: readonly ArchiveAttachmentOutcome[]; folder: ArchiveMailFolder | null }
}

/**
 * Append into a Verlauf that matched, under its render lease: `committed`, or
 * `ineligible` when the person may not write it or it is full, or `busy` when
 * another writer kept the lease for as long as a mail waits.
 */
async function joinThread(
  filing: ArchiveFiling,
  threadId: string,
  pending: PendingEntry
): Promise<'committed' | 'ineligible' | 'busy'> {
  if (!(await waitForLease(threadId, filing.holder))) return 'busy'
  try {
    const target = await writableTarget(filing, threadId)
    if (!target) return 'ineligible'
    const earlier = await findThreadEntryRows(threadId)
    if (earlier.length >= MAIL_THREAD_MAX_ENTRIES) return 'ineligible'
    const fits = await commitEntry(filing, {
      threadId,
      newThread: false,
      threadFolderId: target.folderId,
      title: target.title,
      earlier,
      ...pending,
    })
    return fits ? 'committed' : 'ineligible'
  } finally {
    await releaseRenderLease(threadId, filing.holder)
  }
}

/**
 * Where a matched Verlauf's next Fassung goes, when the person may write it:
 * a Verlauf the import opened and has not rendered yet is its own (the
 * archive's folder); any other must have a document live and readable for
 * them in a folder they may write. Null otherwise.
 */
async function writableTarget(
  filing: ArchiveFiling,
  threadId: string
): Promise<{ folderId: string | null; title: string } | null> {
  const { session, mailImport } = filing
  const thread = await findThreadRow(mailImport.projectId, threadId)
  if (!thread) return null
  if (!thread.documentId) return thread.renderPendingAt ? { folderId: filing.archiveFolderId, title: LONGEST_TITLE } : null
  const writable = await findWritableThread(mailImport.projectId, threadId, memberReader(session.userId))
  if (!writable) return null
  if (!(await canWriteFolder(session, mailImport.projectId, writable.document.folderId))) return null
  return { folderId: writable.document.folderId, title: threadTitleOf(writable.document.filename) }
}

/** Take the lease, waiting a while for another writer to let it go. False when it never did. */
async function waitForLease(threadId: string, holder: string): Promise<boolean> {
  const giveUpAt = Date.now() + RENDER_LEASE_RETRY_MS
  for (;;) {
    if (await acquireRenderLease(threadId, holder, new Date(Date.now() + RENDER_LEASE_MS))) return true
    if (Date.now() + LEASE_POLL_MS > giveUpAt) return false
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS))
  }
}

/**
 * Write the entry, its Message-IDs and what came with it; false when the
 * Verlauf would pass its byte cap with it (it then goes elsewhere).
 */
async function commitEntry(
  filing: ArchiveFiling,
  input: PendingEntry & {
    threadId: string
    newThread: boolean
    threadFolderId: string | null
    title?: string
    earlier: readonly MailThreadEntryRow[]
  }
): Promise<boolean> {
  const { mailImport, session } = filing
  const { message } = input
  const locale = input.newThread ? filing.locale : await threadLocale(mailImport.projectId, input.threadId, filing.locale)
  const unheaded = archiveEntryOf({
    id: input.entryId,
    threadId: input.threadId,
    mailImport,
    message,
    heading: '',
    inReplyToEntryId: answeredEntryOf(input.earlier, message.inReplyTo),
    filedAt: new Date(),
  })
  const entry = {
    ...unheaded,
    heading: mailThreadEntryHeading(
      renderEntryOf(unheaded, []),
      input.earlier.map((row) => row.heading),
      locale
    ),
  }

  const outcomes = input.attachments.outcomes
  const filedDocuments = outcomes.flatMap((outcome) => (outcome.filed ? [outcome.documentId] : []))
  const versions = await currentVersionIds(filedDocuments, session.userId)
  const tree = await filing.folderTree.covering([input.threadFolderId, input.attachments.folder?.id ?? null])
  const rows = archiveAttachmentRowsOf({
    entryId: input.entryId,
    organizationId: mailImport.organizationId,
    projectId: mailImport.projectId,
    outcomes,
    versions,
    folderPaths: new Map(input.attachments.folder ? [[input.attachments.folder.id, input.attachments.folder.path]] : []),
    visibleWithThread: (folderId) => readableWithThread(tree, folderId, input.threadFolderId),
  })

  if (!input.newThread) {
    const earlier = await renderEntriesOf(input.earlier)
    const lines = rows.map((row) => ({ name: row.sectionName ?? null, folderPath: row.sectionFolderPath ?? null }))
    const rendition = renderMailThread({
      title: input.title ?? LONGEST_TITLE,
      locale,
      continues: null,
      entries: [...earlier, renderEntryOf(entry, lines)],
    })
    if (rendition.bytes + RENDERED_BYTES_MARGIN > MAIL_THREAD_MAX_RENDERED_BYTES) return false
  }

  await commitArchiveEntry({
    newThread: input.newThread
      ? {
          id: input.threadId,
          organizationId: mailImport.organizationId,
          projectId: mailImport.projectId,
          documentId: null,
          baseSubject: message.baseSubject.slice(0, 500),
          threadIndexGuid: message.threadIndexGuid,
          participantDomains: participantDomainsOf(message.participants),
          locale,
          createdBy: mailImport.userId,
        }
      : null,
    entry,
    messageIds: { received: message.messageId, referenced: [...message.inReplyTo, ...message.references] },
    attachments: rows,
  })
  return true
}

async function threadLocale(projectId: string, threadId: string, fallback: MailThreadLocale): Promise<MailThreadLocale> {
  return (await findThreadRow(projectId, threadId))?.locale ?? fallback
}

/** The newest Fassung of each document, as the person reads it. */
async function currentVersionIds(documentIds: readonly string[], userId: string): Promise<Map<string, string>> {
  if (documentIds.length === 0) return new Map()
  const current = await findCurrentVersions(documentIds, memberReader(userId))
  return new Map([...current].map(([documentId, version]) => [documentId, version.versionId]))
}

/** Distinct domains of the parties, in one form (`domainOf`), at most 200 (the CHECK). */
function participantDomainsOf(participants: readonly MailThreadParticipant[], known: readonly string[] = []): string[] {
  const domains = new Set(known)
  for (const participant of participants) {
    const domain = domainOf(participant.address)
    if (domain) domains.add(domain)
  }
  return [...domains].slice(0, 200)
}

// ---------------------------------------------------------------------------
// One Fassung per Verlauf per slice
// ---------------------------------------------------------------------------

/** A Verlauf the import could not render, for the import's list of what it skipped. */
export interface ArchiveRenderSkip {
  /** The Verlauf's name as it was tried. */
  name: string
  reason: MailImportSkipReason
}

export interface ArchiveRenderResult {
  rendered: number
  /** Verläufe left for the next slice: another writer held them, or the slice's time was up. */
  waiting: number
  skipped: ArchiveRenderSkip[]
  /** The organization's storage is full: nothing more can be filed. */
  quotaFull: boolean
}

/** Where the slice's Fassungen go: the import's Verlauf batch, opened on first use. */
export interface ArchiveRenderTarget {
  uploadBatchId: () => Promise<string>
  /** Called once per Fassung uploaded, so the batch rolls over when full. */
  counted: () => void
  /** `Date.now()` past which no further Verlauf is started. */
  deadline: number
}

/**
 * Render every Verlauf the import wrote into and has not rendered since, once
 * each (the module header). A Verlauf another writer holds, or one the slice
 * has no time left for, stays pending for the next slice.
 */
export async function renderPendingThreads(
  filing: ArchiveFiling,
  target: ArchiveRenderTarget
): Promise<ArchiveRenderResult> {
  const result: ArchiveRenderResult = { rendered: 0, waiting: 0, skipped: [], quotaFull: false }
  for (const thread of await findPendingThreadsOfImport(filing.mailImport.id)) {
    if (result.quotaFull || Date.now() >= target.deadline) {
      result.waiting += 1
      continue
    }
    if (!(await acquireRenderLease(thread.id, filing.holder, new Date(Date.now() + RENDER_LEASE_MS)))) {
      result.waiting += 1
      continue
    }
    try {
      const outcome = await renderThread(filing, thread.id, target)
      if (outcome.kind === 'rendered') result.rendered += 1
      if (outcome.kind === 'skipped') result.skipped.push(outcome.skip)
      if (outcome.kind === 'quota') result.quotaFull = true
    } finally {
      await releaseRenderLease(thread.id, filing.holder)
    }
  }
  return result
}

type ThreadRender =
  | { kind: 'rendered' }
  | { kind: 'nothing' }
  | { kind: 'skipped'; skip: ArchiveRenderSkip }
  | { kind: 'quota' }

/** One Verlauf's Fassung, under its lease: every entry it holds, uploaded as the person. */
async function renderThread(filing: ArchiveFiling, threadId: string, target: ArchiveRenderTarget): Promise<ThreadRender> {
  const { mailImport, session } = filing
  const thread = await findThreadRow(mailImport.projectId, threadId)
  if (!thread?.renderPendingAt) return { kind: 'nothing' }
  const rows = await findThreadEntryRows(threadId)
  if (rows.length === 0) {
    await giveUpPendingRender(threadId)
    return { kind: 'nothing' }
  }
  const entries = await renderEntriesOf(rows)

  let current: Awaited<ReturnType<typeof findWritableThread>> = null
  if (thread.documentId) {
    current = await findWritableThread(mailImport.projectId, threadId, memberReader(session.userId))
    if (!current) {
      // Its document went to the bin or out of the person's reach after the
      // entries were written: whoever writes its next Fassung renders them.
      await giveUpPendingRender(threadId)
      return { kind: 'nothing' }
    }
  }
  const names = current ? [current.document.filename] : newThreadFilenames(thread, rows, filing.mailImport.userEmail)

  for (const filename of names) {
    const rendition = renderMailThread({ title: threadTitleOf(filename), locale: thread.locale, continues: null, entries })
    if (rendition.bytes > MAIL_THREAD_MAX_RENDERED_BYTES) {
      await giveUpPendingRender(threadId)
      return { kind: 'skipped', skip: { name: threadTitleOf(filename), reason: 'size' } }
    }
    const uploaded = await uploadThreadVersion({
      session,
      projectId: mailImport.projectId,
      folderId: current ? current.document.folderId : filing.archiveFolderId,
      filename,
      markdown: rendition.markdown,
      facts: mailThreadIngestFacts(entries, thread.locale),
      current: current?.document ?? null,
      screeningRelease: false,
      uploadBatchId: await target.uploadBatchId(),
      priority: 'bulk',
      request: filing.request,
    })
    if (uploaded.ok && !current && (await threadHoldingDocument(uploaded.documentId, threadId))) {
      // The same bytes under this name are another Verlauf's document (two
      // imports of one archive, a mail without a Message-ID): never share it.
      continue
    }
    if (uploaded.ok) {
      target.counted()
      await commitArchiveRender({
        threadId,
        documentId: uploaded.documentId,
        versionId: uploaded.versionId,
        entryCount: entries.length,
        renderedBytes: rendition.bytes,
        lastEntryAt: new Date(
          Math.max(...entries.map((entry) => clampSentAt(entry.sentAt, entry.receivedAt).sentAt.getTime()))
        ),
        // A Verlauf that was there keeps its parties: who took part in mail
        // nobody checked never widens what a follow appends (D31, condition 5).
        participantDomains: current
          ? thread.participantDomains
          : participantDomainsOf(rows.flatMap((row) => row.participants), thread.participantDomains),
      })
      return { kind: 'rendered' }
    }
    if (uploaded.failure === 'name_taken' && !current) continue
    if (uploaded.failure === 'quota') return { kind: 'quota' }
    await giveUpPendingRender(threadId)
    return { kind: 'skipped', skip: { name: threadTitleOf(filename), reason: skipReasonOf(uploaded.failure) } }
  }
  await giveUpPendingRender(threadId)
  return { kind: 'skipped', skip: { name: threadTitleOf(names[0] ?? ''), reason: 'name_taken' } }
}

/** `{Gegenüber} {yyyy-mm-dd}.md`, then numbered: the names a Verlauf the import opened is tried under. */
function newThreadFilenames(thread: MailThreadRow, rows: readonly MailThreadEntryRow[], importerEmail: string | null): string[] {
  const first = rows[0]
  const at = clampSentAt(new Date(first.sentAt), new Date(first.receivedAt)).sentAt
  const base = archiveThreadName(counterpartOf(first, importerEmail), at, MAIL_THREAD_RENDER_COPY[thread.locale].unknownSender)
  return Array.from({ length: MAX_THREAD_NAME_ATTEMPTS }, (_, index) =>
    threadDocumentFilename(numbered(base, index + 1))
  )
}

/** The import's skip for a refusal of the upload path a retry would repeat. */
function skipReasonOf(failure: InboundMailFilingFailure): MailImportSkipReason {
  switch (failure) {
    case 'screened':
      return 'screened'
    case 'size':
      return 'size'
    case 'type':
    case 'type_not_accepted':
      return 'type'
    case 'name_taken':
      return 'name_taken'
    default:
      return 'access'
  }
}
