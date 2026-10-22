/**
 * What the person filing a file chose about it, kept on the document's row
 * until the bytes it was chosen for have been read.
 *
 * Two choices travel with an upload's dispatch to `POST /v1/ingest`: the
 * document type (`ShelfUploadInput.documentType`, sent as `document_type`) and
 * the older document these bytes are the new Fassung of
 * (`ShelfUploadInput.revisionOf`, ADR-0099, sent as `revision_of`). A filed
 * mail adds what the filing knew about it (ADR-0134, D36): an E-Mail-Verlauf
 * Fassung's `mail_thread`, an attachment's `mail_origin`
 * (`lib/mail-thread/ingest-facts`). The ingest job stores them once it has
 * read the file. A file the content screening holds
 * (ADR-0086) is never stored: the job stops at the verdict. The reviewer's
 * release later sends the same bytes again (`releaseQuarantinedDocument`), and
 * without the choice the classifier types the file and no Fassung is linked.
 *
 * So every dispatch that carries a choice records it in `documents.metadata`
 * under {@link FILING_CHOICE_METADATA_KEY}, beside the job id and the digest of
 * the bytes that job reads (`ingestContentHash`, `setDocumentIngestJob`). The
 * release reads it back from the row it already loaded, the same "read the
 * row, never trust the caller" argument `dispatchDocument` makes about the
 * file name, and only while the recorded digest is the row's: a choice made for
 * other bytes is not this file's.
 *
 * Only the release reads it. Every dispatch rewrites the metadata, so the next
 * one without a choice (a re-index, a placement move) drops it; were a re-index
 * to carry it, a person's later tag edit would be overwritten by the type chosen
 * at filing, which the ingest job treats as the newest choice.
 */

import type { Document } from '@/lib/db/schema'
import {
  mailOriginIngestFactsSchema,
  mailThreadIngestFactsSchema,
  type MailOriginIngestFacts,
  type MailThreadIngestFacts,
} from '@/lib/mail-thread/ingest-facts'
import { REVISION_MAX_NAME_LENGTH } from './revision-links'
import { documentTypeOf, type DocumentTypeTag } from './tag-vocabulary'

/** The `documents.metadata` key the choice is kept under. */
export const FILING_CHOICE_METADATA_KEY = 'filingChoice'

export interface FilingChoice {
  documentType: DocumentTypeTag | null
  /** The FILE NAME of the older document in the same collection, as `resolveRevisionOf` checked it at upload. */
  revisionOf: string | null
  /** A Fassung of an E-Mail-Verlauf: its messages' facts. Present only then. */
  mailThread?: MailThreadIngestFacts
  /** An attachment filed with a message: the message it came with. Present only then. */
  mailOrigin?: MailOriginIngestFacts
}

/**
 * The JSON a dispatch records for its choice, or null when it carries none (and
 * then nothing is recorded). Keys are present only when chosen.
 */
export function filingChoiceRecord(choice: Partial<{ [K in keyof FilingChoice]: FilingChoice[K] | null }>): Record<string, unknown> | null {
  const record: Record<string, unknown> = {}
  if (choice.documentType) record.documentType = choice.documentType
  if (choice.revisionOf) record.revisionOf = choice.revisionOf
  if (choice.mailThread) record.mailThread = choice.mailThread
  if (choice.mailOrigin) record.mailOrigin = choice.mailOrigin
  return Object.keys(record).length > 0 ? record : null
}

/**
 * The choice recorded with the row's last dispatch, when that dispatch read the
 * bytes the row holds now; null otherwise. A value outside the vocabulary (a
 * type retired since) reads as no type, as a queued job's does.
 */
export function storedFilingChoice(row: Pick<Document, 'metadata' | 'contentHash'>): FilingChoice | null {
  const metadata = asRecord(row.metadata)
  const stored = asRecord(metadata?.[FILING_CHOICE_METADATA_KEY])
  if (!metadata || !stored) return null
  if (!row.contentHash || metadata.ingestContentHash !== row.contentHash) return null
  const documentType = typeof stored.documentType === 'string' ? (documentTypeOf([stored.documentType]) ?? null) : null
  const revisionOf =
    typeof stored.revisionOf === 'string' && stored.revisionOf.trim() && stored.revisionOf.length <= REVISION_MAX_NAME_LENGTH
      ? stored.revisionOf
      : null
  // Parsed as the backend would: a record that no longer fits is no record, never a 422.
  const mailThread = mailThreadIngestFactsSchema.safeParse(stored.mailThread)
  const mailOrigin = mailOriginIngestFactsSchema.safeParse(stored.mailOrigin)
  const mail = {
    ...(mailThread.success ? { mailThread: mailThread.data } : {}),
    // One document is a Verlauf or an attachment, never both (`IngestRequest`).
    ...(mailOrigin.success && !mailThread.success ? { mailOrigin: mailOrigin.data } : {}),
  }
  return documentType || revisionOf || Object.keys(mail).length > 0 ? { documentType, revisionOf, ...mail } : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
