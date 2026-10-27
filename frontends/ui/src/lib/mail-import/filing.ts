/**
 * File one archived mail into the project (ADR-0085, DECISION D33): its
 * attachments into a folder of its own, and its text into the project's
 * E-Mail-Verläufe (`lib/mail-thread/archive.ts`), the same Verläufe mail to the
 * project's address is filed into. A mail without an attachment to file gets
 * no folder.
 *
 * Everything goes through the ordinary upload path as the person who started
 * the import, so the same type, size, quota and permission gates apply as when
 * they drop a file, and the audit trail names them. What a person could not
 * upload is skipped and named, never forced in. That includes the office's
 * name screening (ADR-0086): the import never passes `screeningRelease`,
 * because releasing a screened file is a person's decision about that file and
 * a job cannot make it on their behalf. What the name check stops is counted
 * on the import's upload batch by term, as a browser upload's stops are, once
 * the mail is done (`recordNameStops`, after the cursor moved past it), so a
 * retried mail does not count them twice.
 *
 * **The text after the attachments.** The mail's entry records what became of
 * each attachment (D36: filed as which document and Fassung, or why not), so
 * it is written once they are all decided. Each attachment carries the mail
 * it came with (`mail_origin`, `not_checked`) into ingestion.
 *
 * **Retry-safe by construction.** The job may die anywhere in here and run the
 * same mail again. The mail's folder is recorded (`markInflight`) the moment it
 * exists, so the retry files into it rather than beside it. A file whose name
 * is already in that folder is uploaded under the same name, which makes it the
 * same document again: a new version of it, or `unchanged` when its bytes are
 * identical and it has finished indexing. Never a second document. Names are
 * chosen in attachment order with the names this mail already claimed set
 * aside, so a retry arrives at the same name for the same file. The mail's
 * entry has the import's and the mail's id, so a retry finds it and writes
 * nothing twice.
 *
 * **Free across the whole project.** A project keeps one document per name
 * across all its collections, and a folder with its own access list files into
 * its own collection (ADR-0087). So a name is probed project-wide: one held
 * anywhere but this mail's folder is passed over for ` (2)`, never superseded
 * (which would re-file someone else's document into the mail) and never sent
 * into the upload's cross-collection refusal.
 *
 * A file this import filed that is still held by the content gate (ADR-0086)
 * counts as filed and is not uploaded again: a quarantined one refuses every
 * re-upload (`assertMayReplaceHeld`), so the retry would fail the same way
 * until the import stops. A held file somebody else put under that name in the
 * mail's folder is never replaced; the mail takes the next free name.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { BadRequestError, ConflictError, FileTooLargeError, ForbiddenError, InsufficientStorageError } from '@/lib/api/errors'
import { FOLDER_READ_ONLY_REASON } from '@/lib/authz/folder-access-rule'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport, MailImportSkippedSample, MailImportSkipReason } from '@/lib/db/schema'
import { resolveShelfFolderPath } from '@/lib/documents/folder-path'
import { hasPassedScreening } from '@/lib/documents/document-reader'
import { documentNameKey } from '@/lib/documents/name-match'
import { findLiveDocumentByFilename, findProjectCollectionsHoldingFilename } from '@/lib/documents/repository'
import { assertFileSizeAllowed, assertUploadTypeAllowed, uploadDocument } from '@/lib/documents/service'
import { projectShelf } from '@/lib/documents/shelf'
import { FOLDER_NAME_TAKEN } from '@/lib/documents/shelf-folders'
import { createProjectFolder, ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { domainOf as domainOfAddress } from '@/lib/mail-thread/mail-threading'
import type { NameMatch } from '@/lib/upload-screening/name-screen'
import { ScreenedUploadError } from '@/lib/upload-screening/service'
import { exclusionsByTerm } from '@/lib/upload-screening/name-stop'
import { recordJobUploadExclusions } from '@/lib/upload-batches/service'
import {
  appendArchiveEntry,
  archiveMessageOf,
  FolderTree,
  type ArchiveAttachmentOutcome,
  type ArchiveFiling,
  type ArchiveMailFolder,
} from '@/lib/mail-thread/archive'
import { mailOriginIngestFacts, type MailOriginIngestFacts } from '@/lib/mail-thread/ingest-facts'
import type { MailThreadLocale } from '@/lib/mail-thread/mail-thread-vocabulary'
import {
  AttachmentTooLargeError,
  AttachmentUnreadableError,
  readArchiveAttachment,
  type ArchiveAttachment,
  type ArchiveMail,
  type ArchiveRef,
} from './archive-client'
import { attachmentFilename, mailFolderName, numbered, numberedFilename, outlookFolderPath } from './naming'
import { markInflight } from './repository'
import { importBatchWithRoom, type ImportBatch } from './upload-batch'

/** Candidates tried for a taken name before the mail is given up on. */
const MAX_NAME_ATTEMPTS = 50

/** The slice's time is up in the middle of a mail; the next slice resumes into its folder. */
export class SliceBudgetSpentError extends Error {
  constructor() {
    super('The slice budget was spent in the middle of a mail')
    this.name = 'SliceBudgetSpentError'
  }
}

/** The import moved on under this slice (cancelled, or another slice took it over). */
export class ImportMovedOnError extends Error {
  constructor() {
    super('The import is no longer at this mail')
    this.name = 'ImportMovedOnError'
  }
}

/** The storage quota ran out: no later mail can be filed either. */
export class MailImportQuotaError extends Error {
  constructor() {
    super('The organization’s storage quota is full.')
    this.name = 'MailImportQuotaError'
  }
}

/**
 * Another writer holds the E-Mail-Verlauf the mail's text belongs in (its
 * render lease) for longer than a mail waits. The slice ends and comes back
 * shortly; the mail's folder is recorded, so the retry resumes into it.
 */
export class ThreadBusyError extends Error {
  constructor() {
    super('The mail’s E-Mail-Verlauf is being written by another filing')
    this.name = 'ThreadBusyError'
  }
}

/** What a slice files with: the archive, the folders it made, and what the mails' Verläufe are written with. */
export interface FilingContext extends ArchiveFiling {
  mailImport: MailImport
  archive: ArchiveRef
  /** Outlook folder path → project folder id, for this slice. */
  folders: Map<string, string>
  /** `Date.now()` past which no new attachment is started. */
  deadline: number
  /** The upload batch every attachment is stamped with (`./upload-batch`); moves on when full. */
  uploadBatch: ImportBatch
  /** The batch the slice's Verlauf Fassungen go into, opened when the first is rendered. */
  threadBatch: ImportBatch | null
}

export interface FiledMail {
  folderName: string
  filesFiled: number
  filesSkipped: number
  skipped: MailImportSkippedSample[]
  /** What the name check stopped, one match list per file; recorded on the batch by `recordNameStops`. */
  nameStops: NameMatch[][]
  /** The mail opened an E-Mail-Verlauf. */
  threadsCreated: number
  /** The mail was the import's first into a Verlauf it did not open. */
  threadsAppended: number
  /** The project held the mail's text already (its Message-ID). */
  alreadyInProject: number
}

/**
 * Count a filed mail's name-check stops on the import's upload batch, by term
 * and never by name (ADR-0086). Called once the cursor moved past the mail:
 * the move happens once per mail however often a retry files it, so the stops
 * count once. Never throws (`recordJobUploadExclusions`).
 */
export async function recordNameStops(context: FilingContext, filed: FiledMail): Promise<void> {
  if (filed.nameStops.length === 0) return
  const { organizationId, userId } = context.mailImport
  await recordJobUploadExclusions(organizationId, context.uploadBatch.id, userId, exclusionsByTerm(filed.nameStops))
}

/** Build the context a slice files with: a render-lease holder of its own, the folder tree read on first use. */
export function filingContext(
  input: Omit<FilingContext, 'folders' | 'deadline' | 'holder' | 'folderTree' | 'threadBatch' | 'locale'> & {
    deadline?: number
    locale: MailThreadLocale
  },
): FilingContext {
  return {
    deadline: Number.POSITIVE_INFINITY,
    ...input,
    holder: randomUUID(),
    folderTree: new FolderTree(input.mailImport.organizationId, input.mailImport.projectId),
    threadBatch: null,
    folders: new Map(),
  }
}

/**
 * File one mail. Throws {@link MailImportQuotaError} when nothing more can be
 * stored, {@link SliceBudgetSpentError} when the slice's time ran out between
 * two of its files, {@link ImportMovedOnError} when the import moved on, and
 * {@link ThreadBusyError} when its Verlauf is being written by someone else.
 */
export async function fileMail(context: FilingContext, mail: ArchiveMail): Promise<FiledMail> {
  const sent = mail.attachments.filter((attachment) => !attachment.inline)
  const folder = sent.some((attachment) => !attachment.embedded_message) ? await mailFolder(context, mail) : null
  const folderName = folder?.name ?? mailFolderName(mail.sent_at ?? mail.received_at, mail.sender)
  const result: FiledMail = {
    folderName,
    filesFiled: 0,
    filesSkipped: 0,
    skipped: [],
    nameStops: [],
    threadsCreated: 0,
    threadsAppended: 0,
    alreadyInProject: 0,
  }
  const origin = mailOriginOf(context, mail)
  const outcomes: ArchiveAttachmentOutcome[] = []
  // Names this mail has taken so far: the second `scan.pdf` of one mail is
  // `scan (2).pdf`, not a new version of the first.
  const claimed = new Set<string>()

  for (const attachment of sent) {
    if (Date.now() >= context.deadline) throw new SliceBudgetSpentError()
    const outcome = await fileAttachment(context, mail, folder, attachment, claimed, origin)
    if (outcome.filed) {
      result.filesFiled += 1
      outcomes.push({
        index: attachment.index,
        filename: attachment.filename,
        filed: true,
        documentId: outcome.documentId,
        documentName: outcome.filename,
        folderId: outcome.folderId,
      })
      continue
    }
    result.filesSkipped += 1
    result.skipped.push({ mail: folderName, file: attachment.filename, reason: outcome.reason })
    if (outcome.nameStop) result.nameStops.push(outcome.nameStop)
    outcomes.push({ index: attachment.index, filename: attachment.filename, filed: false, reason: outcome.reason })
  }

  const entry = await appendArchiveEntry(context, mail, { outcomes, folder: folder ? await folderOf(context, folder) : null })
  if (entry.kind === 'busy') throw new ThreadBusyError()
  if (entry.kind === 'already_in_project') result.alreadyInProject = 1
  else {
    result.threadsCreated = entry.threadCreated ? 1 : 0
    result.threadsAppended = entry.threadJoined ? 1 : 0
  }
  return result
}

/** The mail as its attachments carry it into ingestion: when, from whom, unchecked (`not_checked`). */
function mailOriginOf(context: FilingContext, mail: ArchiveMail): MailOriginIngestFacts {
  const message = archiveMessageOf(mail, new Date(context.mailImport.createdAt))
  return mailOriginIngestFacts(
    {
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      senderName: message.sender?.name ?? null,
      senderDomain: domainOfAddress(message.sender?.address),
      signerDomain: null,
      senderTrust: 'not_checked',
    },
    // The Verlauf is chosen after the attachments, whose rows it records (D36):
    // the two-way link is those rows, not this fact.
    { threadDocumentId: null, locale: context.locale },
  )
}

/** The mail folder's path, as a section names where an attachment went. */
async function folderOf(context: FilingContext, folder: MailFolder): Promise<ArchiveMailFolder> {
  const path = await resolveShelfFolderPath(
    projectShelf(context.mailImport.projectId),
    folder.id,
    context.session.organizationId,
  )
  return { id: folder.id, path: path ?? '' }
}

interface MailFolder {
  id: string
  name: string
}

/** The mail's folder: the one a died slice recorded, or a new one with the first free name. */
async function mailFolder(context: FilingContext, mail: ArchiveMail): Promise<MailFolder> {
  const { mailImport, session } = context
  if (mailImport.inflightPosition === mail.position && mailImport.inflightFolderId) {
    const path = await resolveShelfFolderPath(
      projectShelf(mailImport.projectId),
      mailImport.inflightFolderId,
      session.organizationId,
    )
    if (path !== null) return { id: mailImport.inflightFolderId, name: path.split('/').pop() ?? path }
  }
  const parentId = await outlookFolder(context, mail.folder_path)
  const folder = await createFolderWithFreeName(context, parentId, mailFolderName(mail.sent_at ?? mail.received_at, mail.sender))
  // Fenced: a slice that is no longer the import's (cancelled, or another
  // slice moved the cursor) must not file into the folder it just made.
  if (!(await markInflight(session.organizationId, mailImport.id, mail.position, folder.id))) {
    throw new ImportMovedOnError()
  }
  return folder
}

/** The project folder mirroring an Outlook folder path, created on first use. */
async function outlookFolder(context: FilingContext, outlookPath: readonly string[]): Promise<string> {
  const path = outlookFolderPath(outlookPath)
  if (!path) return context.archiveFolderId
  const known = context.folders.get(path)
  if (known) return known

  const ensured = await ensureProjectFolderPaths(
    { projectId: context.mailImport.projectId, parentId: context.archiveFolderId, paths: [path] },
    context.session,
  )
  const id = ensured.ok ? ensured.folderIdByPath[path] : undefined
  if (!id) throw new Error(`could not create the folder ${path}: ${ensured.ok ? 'no id' : ensured.error}`)
  context.folders.set(path, id)
  return id
}

/** Create `name` under `parentId`, or `name (2)`, `name (3)`… when a sibling has it. */
export async function createFolderWithFreeName(
  context: Pick<FilingContext, 'session' | 'mailImport'>,
  parentId: string | null,
  name: string,
): Promise<MailFolder> {
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n += 1) {
    const candidate = numbered(name, n)
    const created = await createProjectFolder(
      { projectId: context.mailImport.projectId, parentId, name: candidate },
      context.session,
    )
    if (created.ok) return { id: created.folder.id, name: created.folder.name }
    if (created.error !== FOLDER_NAME_TAKEN) throw new Error(`could not create the folder ${candidate}: ${created.error}`)
  }
  throw new Error(`no free folder name for ${name} after ${MAX_NAME_ATTEMPTS} attempts`)
}

type AttachmentOutcome =
  | { filed: true; filename: string; documentId: string; folderId: string }
  | { filed: false; reason: MailImportSkipReason; nameStop?: NameMatch[] }

async function fileAttachment(
  context: FilingContext,
  mail: ArchiveMail,
  folder: MailFolder | null,
  attachment: ArchiveAttachment,
  claimed: Set<string>,
  origin: MailOriginIngestFacts,
): Promise<AttachmentOutcome> {
  if (attachment.embedded_message || !folder) return { filed: false, reason: 'embedded_message' }
  const desired = attachmentFilename(folder.name, attachment.filename)
  const refused = await refusalBeforeReading(context.session, desired, attachment.size)
  if (refused) return { filed: false, reason: refused }

  let bytes: Uint8Array
  try {
    bytes = await readArchiveAttachment(context.archive, mail.position, attachment.index)
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) return { filed: false, reason: 'size' }
    if (error instanceof AttachmentUnreadableError) return { filed: false, reason: 'unreadable' }
    throw error
  }
  return fileBytes(context, folder.id, desired, bytes, attachment.content_type ?? '', claimed, origin)
}

/** What the upload gates would refuse, asked before the bytes are fetched from the archive. */
async function refusalBeforeReading(
  session: AuthorizedSession,
  filename: string,
  size: number,
): Promise<MailImportSkipReason | null> {
  try {
    await assertUploadTypeAllowed(session, filename)
  } catch (error) {
    if (error instanceof BadRequestError) return 'type'
    throw error
  }
  try {
    await assertFileSizeAllowed(session.organizationId, size, filename)
  } catch (error) {
    const reason = refusalReason(error)
    if (reason) return reason
    throw error
  }
  return null
}

/**
 * The skip a refusal of the upload path stands for, or null when `error` is not
 * one. Every refusal a retry would repeat belongs here: one left out is
 * rethrown, the job retries the same mail until the import ends `stopped`.
 */
function refusalReason(error: unknown): MailImportSkipReason | null {
  if (error instanceof FileTooLargeError) return 'size'
  if (error instanceof BadRequestError) return 'type'
  if (error instanceof ScreenedUploadError) return 'screened'
  // A folder of the import's tree turned read-only for the person under it (ADR-0088).
  if (error instanceof ForbiddenError && isFolderReadOnly(error.details)) return 'access'
  // Another document took the name elsewhere in the project after the probe (ADR-0087).
  if (error instanceof ConflictError) return 'name_taken'
  return null
}

function isFolderReadOnly(details: unknown): boolean {
  return typeof details === 'object' && details !== null && 'reason' in details && details.reason === FOLDER_READ_ONLY_REASON
}

/**
 * Upload `bytes` into the mail's folder under the first name free in the
 * project: the name used, or why the upload path refused the file. A refusal
 * is one a retry would repeat, so it is a skip, not a failed slice.
 */
async function fileBytes(
  context: FilingContext,
  folderId: string,
  desired: string,
  bytes: Uint8Array,
  contentType: string,
  claimed: Set<string>,
  origin: MailOriginIngestFacts,
): Promise<AttachmentOutcome> {
  const free = await freeFilename(context, folderId, desired, claimed)
  claimed.add(free.filename)
  if (free.filedAs) return { filed: true, filename: free.filename, documentId: free.filedAs, folderId }
  const file = new File([bytes as Uint8Array<ArrayBuffer>], free.filename, { type: contentType })
  context.uploadBatch = await importBatchWithRoom(context.session, context.mailImport, context.uploadBatch)
  try {
    const uploaded = await uploadDocument(
      context.session,
      {
        projectId: context.mailImport.projectId,
        folderId,
        file,
        priority: 'bulk',
        uploadBatchId: context.uploadBatch.id,
        mailOrigin: origin,
      },
      context.request,
    )
    // Unchanged bytes write nothing, so the document does not join the batch.
    if (!uploaded.unchanged) context.uploadBatch.documents += 1
    return { filed: true, filename: free.filename, documentId: uploaded.documentId, folderId }
  } catch (error) {
    if (error instanceof InsufficientStorageError) throw new MailImportQuotaError()
    // Stopped by the name check: its matches travel with the mail and are
    // counted on the batch by term once the mail is done (`recordNameStops`).
    // The import's own skip list names the file.
    if (error instanceof ScreenedUploadError) return { filed: false, reason: 'screened', nameStop: error.matches }
    const reason = refusalReason(error)
    if (reason) return { filed: false, reason }
    throw error
  }
}

/** A name for a file of this mail; `filedAs` the document when this import already filed it and it is still held. */
interface FreeName {
  filename: string
  filedAs: string | null
}

/**
 * The first of `desired`, `desired (2)`… that this mail has not taken already
 * and that no document in the project has, in any of its collections, or that
 * only the one in this very folder has (a retry of this mail). A held document
 * in this folder is the retry's only when this import's person filed it; then
 * it is already filed.
 */
async function freeFilename(
  context: FilingContext,
  folderId: string,
  desired: string,
  claimed: ReadonlySet<string>,
): Promise<FreeName> {
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n += 1) {
    const candidate = documentNameKey(numberedFilename(desired, n))
    if (claimed.has(candidate)) continue
    const state = await nameStateFor(context, folderId, candidate)
    if (state.kind === 'free') return { filename: candidate, filedAs: null }
    if (state.kind === 'filed') return { filename: candidate, filedAs: state.documentId }
  }
  throw new Error(`no free filename for ${desired} after ${MAX_NAME_ATTEMPTS} attempts`)
}

/**
 * `free`: no document of the project holds `filename`, or only a screened one
 * already in `folderId` (this mail's retry). `filed`: the one in `folderId` is
 * still held and this import's person filed it. `taken`: anything else.
 */
async function nameStateFor(
  context: FilingContext,
  folderId: string,
  filename: string,
): Promise<{ kind: 'free' | 'taken' } | { kind: 'filed'; documentId: string }> {
  const { organizationId } = context.session
  const holders = await findProjectCollectionsHoldingFilename(organizationId, context.mailImport.projectId, filename)
  if (holders.length === 0) return { kind: 'free' }
  if (holders.length > 1) return { kind: 'taken' }
  const existing = await findLiveDocumentByFilename(organizationId, holders[0], filename)
  if (!existing || existing.folderId !== folderId) return { kind: 'taken' }
  if (hasPassedScreening(existing)) return { kind: 'free' }
  // Held by the content gate: the retry's own file is filed already; anyone
  // else's is never replaced (a quarantined one refuses it anyway).
  return existing.createdBy === context.session.userId ? { kind: 'filed', documentId: existing.id } : { kind: 'taken' }
}
