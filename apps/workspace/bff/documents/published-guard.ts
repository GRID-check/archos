/**
 * "Publish this version only if the document still answers from the one I
 * read": the compare half of a compare-and-swap on `documents.published_version_id`.
 *
 * A writer that edits the CURRENT Fassung as a whole (a Skizze saved from the
 * editor, ADR-0148) reads a version, changes it, and publishes the result. A
 * second writer that published in between would be silently superseded, so the
 * check runs inside {@link insertPublishedVersion}'s transaction, after
 * `allocateVersionNumber` has taken the per-document lock every version writer
 * of this document takes: between this read and the pointer move nobody else
 * publishes a version of it.
 */

import { and, eq } from 'drizzle-orm'
import { ConflictError } from '@/lib/api/errors'
import { documents } from '@/lib/db/schema/documents'
import type { DbTransaction } from '@/lib/storage/repository'

/** A 409 naming the Fassung that is current now, so the caller can read it and redo its change. */
export class PublishedVersionMovedError extends ConflictError {
  constructor(
    readonly documentId: string,
    readonly currentVersionId: string | null,
  ) {
    super('A newer version of this document exists', { reason: 'stale_base_version', currentVersionId })
    this.name = 'PublishedVersionMovedError'
  }
}

/** What the writer read: the published version id, `null` for a document that had none yet. */
export interface PublishedVersionExpectation {
  publishedVersionId: string | null
  /**
   * Another document of the same organization whose published version this
   * is, when the write is derived from it: a Skizze's PDF is published only
   * while the SVG Fassung it was drawn from is current. Checked under the lock
   * of the document written, so of two such writes the later source's lands last.
   */
  of?: string
}

export async function assertPublishedVersionIs(
  tx: DbTransaction,
  documentId: string,
  organizationId: string,
  expected: PublishedVersionExpectation,
): Promise<void> {
  const target = expected.of ?? documentId
  const [row] = await tx
    .select({ publishedVersionId: documents.publishedVersionId })
    .from(documents)
    .where(and(eq(documents.id, target), eq(documents.organizationId, organizationId)))
  const current = row?.publishedVersionId ?? null
  if (current !== expected.publishedVersionId) throw new PublishedVersionMovedError(target, current)
}
