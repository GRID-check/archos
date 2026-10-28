/** Revision counterparts and document name probes. */

import 'server-only'
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { projectShelf, shelfDocumentWhere, type DocumentShelf } from '../shelf'
import { documentAliasKey, documentNameVariants } from '../name-match'
import { FILENAME_LOOKUP_MAX_NAMES } from '../filename-lookup'
import { documents, type DocumentAuthor, type DocumentLifecycle } from '@/lib/db/schema/documents'
import { documentVisibleTo, type DocumentReader } from '../visibility'
import { DOCUMENT_LIST_LIMIT, type ListProjectDocumentsOptions, outsideHiddenFolders } from './list'

/** A document a Fassung link may point to, as the resolution needs it. */
export interface RevisionCounterpartRow {
  id: string
  filename: string
  projectId: string | null
  folderId: string | null
  createdAt: Date | null
}

/**
 * The documents of ONE collection named `filenames` that `reader` may see, for
 * resolving a Fassung link's file names to documents (`revision-links-loader.ts`).
 *
 * The link is stored by file name in the backend's index, which knows nothing
 * of who may read what, so this is where a name becomes a document or stays a
 * string nobody sees: held rows (`documentVisibleTo`, ADR-0086) and archived
 * ones are not found. The folder rule (ADR-0087) is the caller's, from the
 * project it reads each row's `projectId` for; a row's folder is returned for
 * exactly that. Person-uploaded rows only: a machine-authored row owns no
 * chunks of its own, so no link of the index can name it.
 *
 * Every name is looked up, in queries of at most {@link FILENAME_LOOKUP_MAX_NAMES}
 * names each: a page of a few hundred documents references more names than one
 * query carries, and a name left out was a link silently lost (the older
 * Fassung shown as current, the count wrong).
 */
export async function findRevisionCounterparts(
  organizationId: string,
  collectionName: string,
  filenames: readonly string[],
  reader: DocumentReader,
): Promise<RevisionCounterpartRow[]> {
  const unique = [...new Set(filenames)]
  const byId = new Map<string, RevisionCounterpartRow>()
  for (let start = 0; start < unique.length; start += FILENAME_LOOKUP_MAX_NAMES) {
    const chunk = unique.slice(start, start + FILENAME_LOOKUP_MAX_NAMES)
    for (const row of await findRevisionCounterpartChunk(organizationId, collectionName, chunk, reader)) byId.set(row.id, row)
  }
  return [...byId.values()]
}

/** One bounded query of {@link findRevisionCounterparts}: at most {@link FILENAME_LOOKUP_MAX_NAMES} names. */
async function findRevisionCounterpartChunk(
  organizationId: string,
  collectionName: string,
  filenames: readonly string[],
  reader: DocumentReader,
): Promise<RevisionCounterpartRow[]> {
  const variants = [...new Set(filenames.flatMap(documentNameVariants))]
  if (variants.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select({
        id: documents.id,
        filename: documents.filename,
        projectId: documents.projectId,
        folderId: documents.folderId,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.collectionName, collectionName),
          inArray(documents.filename, variants),
          eq(documents.authoredBy, 'user'),
          eq(documents.lifecycle, 'active'),
          documentVisibleTo(reader),
        ),
      )
      .orderBy(asc(documents.id))
      .limit(DOCUMENT_LIST_LIMIT),
  )
}

/** One row of a name probe (`name-probe-types.ts` is its wire shape). */
export interface DocumentNameMatchRow {
  id: string
  filename: string
  displayName: string | null
  fileSize: number | null
  contentHash: string | null
  status: string
  folderId: string | null
  authoredBy: DocumentAuthor
  lifecycle: DocumentLifecycle
}

export const documentNameMatchColumns = {
  id: documents.id,
  filename: documents.filename,
  displayName: documents.displayName,
  fileSize: documents.fileSize,
  contentHash: documents.contentHash,
  status: documents.status,
  folderId: documents.folderId,
  authoredBy: documents.authoredBy,
  lifecycle: documents.lifecycle,
}

/** Names per probe query; a longer probe runs several bounded queries. */
const NAME_PROBE_CHUNK = 500
/** Rows per probe query: one identity match per name plus room for aliases. */
const NAME_PROBE_ROW_LIMIT = NAME_PROBE_CHUNK * 4

/**
 * The rows answering to any of `names`, as the upload planner compares them:
 * the filename in either Unicode form (IDENTITY — what the upload replaces),
 * or the filename or rename case-folded (RECOGNITION — the planner's
 * `duplicate`). See `name-match.ts` for the two keys.
 *
 * Person-uploaded rows only, and every lifecycle: exactly the rows
 * `findLiveDocumentByFilename` would version, so the plan cannot promise „Neu"
 * for a file the server is about to put on an archived document.
 */
function nameProbeWhere(names: readonly string[]): SQL | undefined {
  const exact = [...new Set(names.flatMap(documentNameVariants))]
  const folded = [...new Set(names.flatMap((name) => documentNameVariants(documentAliasKey(name))))]
  return and(
    eq(documents.authoredBy, 'user'),
    or(
      inArray(documents.filename, exact),
      inArray(sql`lower(${documents.filename})`, folded),
      inArray(sql`lower(${documents.displayName})`, folded),
    ),
  )
}

/**
 * Run a name probe in bounded chunks and merge the answers (a document can
 * answer to names in two chunks; it is returned once).
 */
export async function probeDocumentNames(
  names: readonly string[],
  query: (where: SQL | undefined, limit: number) => Promise<DocumentNameMatchRow[]>,
): Promise<DocumentNameMatchRow[]> {
  const byId = new Map<string, DocumentNameMatchRow>()
  const unique = [...new Set(names)]
  for (let start = 0; start < unique.length; start += NAME_PROBE_CHUNK) {
    const rows = await query(nameProbeWhere(unique.slice(start, start + NAME_PROBE_CHUNK)), NAME_PROBE_ROW_LIMIT)
    for (const row of rows) byId.set(row.id, row)
  }
  return [...byId.values()]
}

/** The documents of a shelf answering to any of `names` — see {@link nameProbeWhere}. */
export async function findDocumentsByNames(
  shelf: DocumentShelf,
  organizationId: string,
  names: readonly string[],
  { hiddenFolderIds, reader }: Pick<ListProjectDocumentsOptions, 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentNameMatchRow[]> {
  const db = getDb()
  return probeDocumentNames(names, (where, limit) =>
    withTenant({ organizationId }, () =>
      db
        .select(documentNameMatchColumns)
        .from(documents)
        .where(
          and(
            shelfDocumentWhere(shelf, organizationId),
            ...outsideHiddenFolders(hiddenFolderIds),
            // The probe answers with the digest: somebody else's unscreened
            // file would let a member confirm its contents by hash (ADR-0086).
            documentVisibleTo(reader),
            where,
          ),
        )
        .orderBy(desc(documents.createdAt), asc(documents.id))
        .limit(limit),
    ),
  )
}

/** The project documents answering to any of `names` — see {@link nameProbeWhere}. */
export function findProjectDocumentsByNames(
  projectId: string,
  organizationId: string,
  names: readonly string[],
  options: Pick<ListProjectDocumentsOptions, 'hiddenFolderIds' | 'reader'>,
): Promise<DocumentNameMatchRow[]> {
  return findDocumentsByNames(projectShelf(projectId), organizationId, names, options)
}
