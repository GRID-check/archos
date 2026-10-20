/**
 * The rows a dropped file may be the next Fassung of: documents of one shelf
 * whose file name contains a word of the dropped name's series.
 *
 * The revision grammar (`revision-series.ts`) runs in TypeScript, not in SQL,
 * so the database can only narrow: a document of the same series shares the
 * series key's words with the dropped name, whatever index or date it carries.
 * The longest plain word of the key is the narrowest one that survives the
 * Unicode forms a file name may be stored in; the grammar then decides which
 * of the narrowed rows really belong. Bounded twice: by the words asked about,
 * and by a row limit that keeps the newest.
 */

import 'server-only'
import { and, asc, desc, eq, ilike, or } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { documents } from '@/lib/db/schema'
import { likeContains } from '@/lib/text/like-pattern'
import { shelfDocumentWhere, type DocumentShelf } from './shelf'
import { documentVisibleTo, type DocumentReader } from './visibility'
import { outsideHiddenFolders } from './repository'
import type { AuthoredDocumentRow } from './collection-file-ref'

/** Rows one query keeps (newest first): a series has a handful of documents, a shelf of a common word many. */
export const REVISION_SERIES_ROW_LIMIT = 1000

/** A document of the shelf that may belong to a series. */
export interface RevisionSeriesRow extends AuthoredDocumentRow {
  id: string
  displayName: string | null
  folderId: string | null
  createdAt: Date | null
}

/**
 * The person-uploaded, active documents of `shelf` that `reader` may see, outside
 * the folders closed to them, whose file name contains any of `words`.
 */
export async function findRevisionSeriesRows(
  shelf: DocumentShelf,
  organizationId: string,
  words: readonly string[],
  { hiddenFolderIds, reader }: { hiddenFolderIds?: readonly string[]; reader: DocumentReader },
): Promise<RevisionSeriesRow[]> {
  if (words.length === 0) return []
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        displayName: documents.displayName,
        folderId: documents.folderId,
        createdAt: documents.createdAt,
        collectionName: documents.collectionName,
        authoredBy: documents.authoredBy,
        publishedVersionId: documents.publishedVersionId,
      })
      .from(documents)
      .where(
        and(
          shelfDocumentWhere(shelf, organizationId),
          ...outsideHiddenFolders(hiddenFolderIds),
          // The answer names a document: somebody else's unscreened file is not offered (ADR-0086).
          documentVisibleTo(reader),
          // A machine-authored row owns no chunks, so no link of the index can name it.
          eq(documents.authoredBy, 'user'),
          eq(documents.lifecycle, 'active'),
          or(...words.map((word) => ilike(documents.filename, likeContains(word)))),
        ),
      )
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(REVISION_SERIES_ROW_LIMIT),
  )
  // Coerced at the boundary: a driver may hand a timestamp back as a string.
  return rows.map((row) => ({ ...row, createdAt: row.createdAt ? new Date(row.createdAt) : null }))
}
