/**
 * Checking a „Als neue Fassung von X ablegen" that arrives with an upload
 * (CONTEXT.md, „Fassung"; ADR-0097), before a byte is stored.
 *
 * The browser sends the id of the older document the reader ticked. Python
 * writes the link once the new file has been read, from the older document's
 * FILE NAME, so everything that must be true is decided here first, by the
 * same rules `PUT /api/documents/{id}/fassung` applies to the older document
 * (`fassung-service.ts`): the caller may change it (write on its shelf and
 * folder), it is past screening, it is a person's upload and not archived, and
 * it lives on the shelf and in the collection the new file is going to. An
 * older document the caller may not open is a 404, as everywhere else.
 *
 * What it answers is the older file's name for the ingest job, or `null` when
 * there is nothing to link: no choice was made, or the new file has the older
 * one's own name, which is a new version of it (ADR-0054) and never a Fassung.
 */

import 'server-only'
import { z } from 'zod'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from './access'
import { collectionFileRef } from './collection-file-ref'
import { hasPassedScreening } from './document-reader'
import { documentNameKey } from './name-match'
import { documentShelf, type DocumentShelf } from './shelf'

const olderIdSchema = z.string().uuid()

/**
 * The `fassungOf` form field of an upload: the older document's id, or `null`
 * when the field is absent or empty. Anything else is a malformed request, not
 * a choice to quietly drop.
 */
export function readFassungOf(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = olderIdSchema.safeParse(value.trim())
  if (!parsed.success) throw new BadRequestError('fassungOf must be a document id', { reason: 'invalid_fassung_of' })
  return parsed.data
}

/** Where the new file is going, as the upload has decided it. */
export interface FassungUploadTarget {
  shelf: DocumentShelf
  /** The collection the new file will be indexed into (a restricted folder has its own, ADR-0087). */
  collectionName: string
  /** The new file's stored name. */
  filename: string
}

function sameShelf(a: DocumentShelf, b: DocumentShelf | null): boolean {
  if (!b || a.kind !== b.kind) return false
  return a.kind === 'archiv' || (b.kind === 'project' && a.projectId === b.projectId)
}

/** The older file's name to link, or `null` for nothing to link. Throws when the choice may not be honoured. */
export async function resolveFassungOf(
  session: AuthorizedSession,
  olderId: string | null | undefined,
  target: FassungUploadTarget,
): Promise<string | null> {
  if (!olderId) return null
  const older = await getAccessibleDocument(session, olderId, 'write')
  // A held upload is its uploader's and the reviewers' alone (ADR-0086), and a link would carry its
  // name, and through the change summary what it holds, into documents everyone reads.
  if (!hasPassedScreening(older)) throw new NotFoundError()
  if (!sameShelf(target.shelf, documentShelf(older))) {
    throw new BadRequestError('The older document is on another shelf', { reason: 'different_shelf' })
  }
  if (older.lifecycle !== 'active') {
    throw new BadRequestError('An archived document has no Fassungen', { reason: 'archived' })
  }
  if (older.collectionName !== target.collectionName) {
    throw new BadRequestError('Both documents must be in the same collection', { reason: 'different_collection' })
  }
  // The same gate as every `(collection, filename)` call: a machine-authored row owns no chunks over there.
  if (!collectionFileRef(older)) throw new NotFoundError()
  if (documentNameKey(older.filename) === documentNameKey(target.filename)) return null
  return older.filename
}
