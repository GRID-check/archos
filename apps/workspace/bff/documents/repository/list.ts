/** Document listings: the bounded project page and its cursor. */

import 'server-only'
import { and, asc, desc, eq, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { projectShelf, shelfDocumentWhere, type DocumentShelf } from '../shelf'
import { CURSOR_TIMESTAMP_FORMAT, type DocumentListCursor } from '../list-cursor'
import { documents, type DocumentAuthor, type DocumentLifecycle } from '@/lib/db/schema/documents'
import type { DocumentScope, DocumentScreeningOutcome } from '@/lib/db/schema/documents'
import { type StoredQuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { documentVisibleTo, type DocumentReader } from '../visibility'
import { type IngestFailureCategory } from '../retry-policy'

/**
 * Hard cap on one page of a document listing (project and Archiv alike).
 * A caller that needs the whole corpus follows `nextCursor`
 * (`listProjectDocumentPage`), it never raises this.
 */
export const DOCUMENT_LIST_LIMIT = 500

/** The column subset the list endpoint serves (metadata is stripped later). */
export interface DocumentListRow {
  id: string
  filename: string
  /**
   * The shelf the row is on (`documentShelf`). Read by the status
   * reconciliation, which announces a settled row on its shelf's live channel;
   * a listing row that did not carry it settled for nobody. Not on the wire.
   */
  projectId: string | null
  scope: DocumentScope
  /** The rename, when there is one; NULL means "show `filename`" (0048). */
  displayName: string | null
  fileSize: number | null
  contentType: string | null
  status: string
  /**
   * Whose hand wrote the bytes (migration 0063).
   *
   * On the LIST row and not only on the full document, because "Von Piloti
   * erstellt" is a line in the Files pane and the pane never loads the full
   * row. Serving it here rather than deriving it from `status === 'stored'` in
   * the UI keeps the two facts separate: `stored` is what happened to the
   * INDEXING, `authoredBy` is who wrote it, and a future producer that does get
   * indexed would make the derivation quietly wrong.
   */
  authoredBy: DocumentAuthor
  /**
   * The version the item's storage columns mirror, or `null` (ADR-0054).
   *
   * On the LIST row because `collectionFileRef` REQUIRES it: a machine-authored
   * row owns chunks only once a version of it has been published, and the two
   * sweeps that address the backend from a list — the status/metadata
   * reconcile and the session-document cleanup — build their refs out of these
   * rows. A row type that cannot answer the question cannot be handed to the
   * constructor at all, which is the same argument `authoredBy` makes one line
   * up.
   */
  publishedVersionId: string | null
  /**
   * Whether the item is in the working set (ADR-0054).
   *
   * On the LIST row because the one surface that asks for archived documents
   * shows them MIXED with the active ones — a listing that could not say which
   * is which would be a pane where „archiviert" is invisible again, one layer
   * further in.
   */
  lifecycle: DocumentLifecycle
  collectionName: string
  folderId: string | null
  /**
   * Where the file came from, when a folder upload recorded one (0071).
   * On the list row because the Files pane shows it in the detail rail without
   * a second fetch — and because "go back to the original" is the one thing a
   * reader wants from it, which is a per-file question.
   */
  originPath: string | null
  /**
   * A digest of the stored bytes (`sha256:<hex>`), or null when unknown.
   *
   * On the LIST row because the folder-upload planner runs in the browser: it
   * compares what the reader just dropped against the corpus it already has on
   * screen, and a second request per candidate file would be a round trip to
   * learn that nothing needs uploading.
   */
  contentHash: string | null
  /**
   * Who uploaded it, and the content gate's verdict. On the LIST row for one
   * reader: a listing reconciles its rows after the query, and a row the
   * reconcile turns `quarantined` must be narrowed again by the same rule the
   * query applied (`keepReadable` in `./document-reader`, ADR-0086). Neither
   * leaves the BFF (`toListedDocuments` drops them).
   */
  createdBy: string
  screeningOutcome: DocumentScreeningOutcome | null
  /** The digest the verdict judged (migration 0123); dropped with the two above. */
  screenedHash: string | null
  createdAt: Date
  updatedAt: Date
  errorMessage: string | null
  metadata: unknown
  /**
   * Why the last read failed, and what read it (migration 0134). On the LIST
   * row for one decision: whether the listing offers the document to „Alle
   * erneut lesen“ (`canRetryRow`, `./retry-policy`), which needs `metadata` and
   * `contentHash` beside them. Turned into `retryable` and dropped before the
   * row leaves the BFF (`toListedDocuments`). Optional because rows built by
   * other selects (and the specs' fixtures) predate them; absent reads as
   * "not recorded", which the rule treats as retryable.
   */
  ingestFailureCategory?: IngestFailureCategory | null
  ingestRetryable?: boolean | null
  ingestReaderVersion?: string | null
  /**
   * Why the content gate held it (migration 0148), as stored. Turned into the
   * reader's verdict by `toListedDocuments` (`quarantineVerdictOf`) and only
   * then served, to whoever the listing's reader rule let see the held row.
   * Optional for the same reason as the three above.
   */
  quarantine?: StoredQuarantineVerdict | null
}

/**
 * `authoredBy` narrows the listing to one hand — the query behind the `Von
 * Piloti` chip (agent-authored documents design, decision 9).
 *
 * A trailing optional parameter rather than an options object, so every existing
 * caller keeps compiling and keeps meaning "both hands". Omitted is not the same
 * as `'user'`: the unfiltered listing is the whole project's estate, which is
 * what the Files pane shows by default.
 *
 * It is a column filter and not a folder filter on purpose. How a report is
 * FILED and how it is FOUND are different questions, and tying the second to the
 * first is what turns a folder convention into a load-bearing one — moving,
 * renaming or abandoning `Berichte` later has to cost nothing. The partial index
 * `documents_agent_authored_idx` (migration 0063) is on
 * `(project_id, created_at DESC) WHERE authored_by = 'agent'`, so the `'agent'`
 * case — the one any surface actually asks for — is a point query in the
 * listing's own sort order.
 */
export interface ListProjectDocumentsOptions {
  limit?: number
  /**
   * Rows to skip before the page — the draft-filing veto's paginated scan.
   * Default 0 (first page, as before); bounded below like `limit` so a
   * negative offset cannot widen the listing.
   */
  offset?: number
  authoredBy?: DocumentAuthor
  /**
   * Show the documents somebody archived as well (ADR-0054).
   *
   * Default false, and that default is the point of the column: „archiviert"
   * is a statement that the file has left the working set, and a file that is
   * still in every listing has not left it. The archive gesture already purges
   * the chunks so the agent stops citing it; the listing was the other half and
   * it was missing, which made the whole act read as a no-op with an audit
   * event.
   *
   * An OPTION rather than a second query, because the surface that shows them
   * (the Files filter's „Archiviert" chip) needs the same projection, the same
   * cap and the same assignment hydration as the default one — a second query
   * would be a second definition of what a document listing is.
   */
  includeArchived?: boolean
  /**
   * Folders whose documents this reader may not see (ADR-0087), from
   * `getHiddenFolderIds`. Their rows are left out as if they did not exist.
   */
  hiddenFolderIds?: readonly string[]
  /**
   * Who reads the listing (ADR-0086), from `shelfReaderFor`: a member sees the
   * screened rows and the held rows they uploaded, a reviewer every row.
   * Required, so no listing can forget the hold.
   */
  reader: DocumentReader
}

/**
 * Rows outside every hidden folder; nothing when none is hidden. Exported for
 * the other queries over `documents` that serve a reader (the project
 * overview), so "hidden" has one SQL spelling.
 */
export function outsideHiddenFolders(hiddenFolderIds: readonly string[] | undefined): SQL[] {
  if (!hiddenFolderIds || hiddenFolderIds.length === 0) return []
  const visible = or(isNull(documents.folderId), notInArray(documents.folderId, [...hiddenFolderIds]))
  return visible ? [visible] : []
}

/**
 * The columns a listing serves — one definition for the project listing, its
 * keyset page and the Archiv's, so the three cannot disagree about what a
 * `DocumentListRow` is.
 */
export const documentListColumns = {
  id: documents.id,
  filename: documents.filename,
  projectId: documents.projectId,
  scope: documents.scope,
  displayName: documents.displayName,
  fileSize: documents.fileSize,
  contentType: documents.contentType,
  status: documents.status,
  authoredBy: documents.authoredBy,
  publishedVersionId: documents.publishedVersionId,
  lifecycle: documents.lifecycle,
  collectionName: documents.collectionName,
  folderId: documents.folderId,
  originPath: documents.originPath,
  contentHash: documents.contentHash,
  createdBy: documents.createdBy,
  screeningOutcome: documents.screeningOutcome,
  screenedHash: documents.screenedHash,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  errorMessage: documents.errorMessage,
  quarantine: documents.quarantine,
  metadata: documents.metadata,
  ingestFailureCategory: documents.ingestFailureCategory,
  ingestRetryable: documents.ingestRetryable,
  ingestReaderVersion: documents.ingestReaderVersion,
}

/**
 * The rows a listing of `shelf` shows — the one definition behind a project's
 * Dateien and the org-wide Archiv (ADR-0078), so the two cannot disagree about
 * what a document listing is. The shelf (`shelfDocumentWhere`) names the scope
 * for both, rather than leaving one of them correct by the accident of a NULL
 * project; `authoredBy` and the lifecycle rule are the same predicates on both.
 */
export function listingWhere(
  shelf: DocumentShelf,
  organizationId: string,
  {
    authoredBy,
    includeArchived = false,
    hiddenFolderIds,
    reader,
  }: Pick<ListProjectDocumentsOptions, 'authoredBy' | 'includeArchived' | 'hiddenFolderIds' | 'reader'>,
): SQL | undefined {
  return and(
    shelfDocumentWhere(shelf, organizationId),
    ...(authoredBy ? [eq(documents.authoredBy, authoredBy)] : []),
    ...(includeArchived ? [] : [eq(documents.lifecycle, 'active')]),
    ...outsideHiddenFolders(hiddenFolderIds),
    documentVisibleTo(reader),
  )
}

export function boundListLimit(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit)), DOCUMENT_LIST_LIMIT)
}

export async function listProjectDocuments(
  projectId: string,
  organizationId: string,
  { limit = DOCUMENT_LIST_LIMIT, offset = 0, authoredBy, includeArchived = false, hiddenFolderIds, reader }: ListProjectDocumentsOptions,
): Promise<DocumentListRow[]> {
  const boundedLimit = boundListLimit(limit)
  const boundedOffset = Math.max(0, Math.trunc(offset))
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select(documentListColumns)
      .from(documents)
      .where(listingWhere(projectShelf(projectId), organizationId, { authoredBy, includeArchived, hiddenFolderIds, reader }))
      // Newest first, with the id as tiebreak: createdAt ties are real (a
      // batch import lands on one timestamp), and under offset pagination an
      // unstable order drops rows from one page and repeats them on the next.
      .orderBy(desc(documents.createdAt), asc(documents.id))
      .limit(boundedLimit)
      .offset(boundedOffset),
  )
}

/** One page of a keyset listing, and where the next one starts. */
export interface DocumentListPage {
  rows: DocumentListRow[]
  /** The position after the last row, or `null` when this page is the last. */
  nextCursor: DocumentListCursor | null
}

/**
 * Rows strictly after `cursor` in the `created_at DESC, id ASC` order.
 *
 * The comparison is against the cursor's microsecond text, parsed as UTC, so
 * it matches the column exactly — see `list-cursor.ts` for why a `Date` would
 * not.
 */
export function afterDocumentListCursor(cursor: DocumentListCursor): SQL {
  const at = sql`(${cursor.createdAt}::timestamp AT TIME ZONE 'UTC')`
  return sql`(${documents.createdAt} < ${at} OR (${documents.createdAt} = ${at} AND ${documents.id} > ${cursor.id}::uuid))`
}

/**
 * Fetch one page of `limit + 1` rows and split off the probe row.
 *
 * The extra row is how "is there more" is answered without a COUNT: a page
 * that came back full is not proof of a next one, and a client that asked
 * again only to receive nothing would pay a round trip to learn it.
 */
export async function readDocumentListPage(
  query: (probeLimit: number) => Promise<Array<DocumentListRow & { cursorCreatedAt: string }>>,
  limit: number,
): Promise<DocumentListPage> {
  const bounded = boundListLimit(limit)
  const fetched = await query(bounded + 1)
  const hasMore = fetched.length > bounded
  const page = hasMore ? fetched.slice(0, bounded) : fetched
  const rows = page.map(({ cursorCreatedAt: _cursor, ...row }) => ({
    ...row,
    // Coerced at the boundary: a raw driver can hand the timestamp back as text.
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }))
  const last = page.at(-1)
  return {
    rows,
    nextCursor: hasMore && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
  }
}

/** The microsecond UTC text of `created_at`, which a cursor is built from. */
export const cursorCreatedAtColumn = sql<string>`to_char(${documents.createdAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`

/**
 * One keyset page of a shelf's documents — the listing the Files pane drains,
 * page after page, so no document past the first `DOCUMENT_LIST_LIMIT` falls
 * off it. A project's Dateien and the org-wide Archiv are this one query
 * (ADR-0078): same columns, same order, same lifecycle and author filters.
 *
 * Each query stays bounded; completeness comes from following `nextCursor`,
 * never from a larger limit.
 */
export async function listDocumentPage(
  shelf: DocumentShelf,
  organizationId: string,
  {
    limit = DOCUMENT_LIST_LIMIT,
    cursor,
    authoredBy,
    includeArchived = false,
    hiddenFolderIds,
    reader,
  }: Omit<ListProjectDocumentsOptions, 'offset'> & { cursor?: DocumentListCursor },
): Promise<DocumentListPage> {
  const db = getDb()
  return readDocumentListPage(
    (probeLimit) =>
      withTenant({ organizationId }, () =>
        db
          .select({ ...documentListColumns, cursorCreatedAt: cursorCreatedAtColumn })
          .from(documents)
          .where(
            and(
              listingWhere(shelf, organizationId, { authoredBy, includeArchived, hiddenFolderIds, reader }),
              ...(cursor ? [afterDocumentListCursor(cursor)] : []),
            ),
          )
          .orderBy(desc(documents.createdAt), asc(documents.id))
          .limit(probeLimit),
      ),
    limit,
  )
}

/** One keyset page of a project's documents — see {@link listDocumentPage}. */
export function listProjectDocumentPage(
  projectId: string,
  organizationId: string,
  options: Omit<ListProjectDocumentsOptions, 'offset'> & { cursor?: DocumentListCursor },
): Promise<DocumentListPage> {
  return listDocumentPage(projectShelf(projectId), organizationId, options)
}

// --- A folder level, page by page (ADR-0102) ---------------------------------
