/**
 * The SQL behind a project's Offene Punkte: the live Anmerkungen of every
 * document of one project, a bounded page at a time.
 *
 * No authorization here; the service (`./project-marks.ts`) checks the
 * project and hands in who reads. The query joins `documents` and narrows them
 * exactly as the project's own listing does (`listingWhere` in
 * `lib/documents/repository.ts`): the project's shelf, active documents only
 * (an archived one has left the working set), outside every folder hidden from
 * the reader (ADR-0087; a folder in the Papierkorb is hidden from everyone),
 * and `documentVisibleTo(reader)`, so a held upload's marks are as invisible
 * as the upload (ADR-0086). `documents/document-visibility.spec.ts` holds this
 * function to that.
 */

import 'server-only'
import { and, asc, eq, gte, inArray, lt, lte, not, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentAnnotations } from '@/lib/db/schema/document-annotations'
import { documentVersions } from '@/lib/db/schema/document-versions'
import { documents, type Document } from '@/lib/db/schema/documents'
import { withTenant } from '@/lib/db/tenant-context'
import { outsideHiddenFolders } from '@/lib/documents/repository'
import { projectShelf, shelfDocumentWhere } from '@/lib/documents/shelf'
import { documentVisibleTo, SCREENED_ONLY, type DocumentReader } from '@/lib/documents/visibility'
import { MAX_PROJECT_MARKS_PAGE, type ProjectMarkOrder } from './project-types'
import {
  carriedCopy,
  carriedSource,
  carryJoins,
  selection,
  withThreads,
  type AnnotationRecord,
} from './repository'
import type { AnnotationStatus } from './types'

/** Where a mark without a Frist sorts by date: after every real one, never as NULL (a NULL key needs its own arm in every comparison). */
export const NO_DUE_DATE = '9999-12-31'

/**
 * One position in a page's order. Both orders carry every key, so a cursor is
 * read back the same way whichever wrote it; `due` is {@link NO_DUE_DATE} for
 * a mark without one. `name` is the key as Postgres case-folded it, read off
 * the row, never folded again in JavaScript.
 */
export interface ProjectMarkCursor {
  due: string
  name: string
  documentId: string
  number: number
}

/** The Frist, as calendar days (`YYYY-MM-DD`): before a day, or from one through another. */
export type DueRange = { before: string } | { from: string; through: string }

export interface ProjectAnnotationPageQuery {
  /** Who reads (`shelfReaderFor`): a held upload's marks only for its uploader and its reviewers. */
  reader: DocumentReader
  /** Folders whose documents the reader may not see (`getHiddenFolderIds`). */
  hiddenFolderIds: readonly string[]
  statuses: readonly AnnotationStatus[]
  /** Only marks with this Zuständige. */
  assigneeUserId?: string | null
  due?: DueRange | null
  order: ProjectMarkOrder
  /** The previous page's last position; the first page when null. */
  cursor: ProjectMarkCursor | null
  /** Clamped to 1…{@link MAX_PROJECT_MARKS_PAGE}. */
  limit: number
}

/** A mark with its thread and the document it sits on, as the reader's listing would show that document. */
export interface ProjectAnnotationRecord extends AnnotationRecord {
  document: Document
}

export interface ProjectAnnotationPage {
  records: ProjectAnnotationRecord[]
  /** The last row's position when a further page exists, else null. */
  next: ProjectMarkCursor | null
}

/** The document's shown name, case-folded by Postgres: the sort key and the cursor's `name`. */
const nameKey = sql<string>`lower(coalesce(${documents.displayName}, ${documents.filename}))`
const dueKey = sql`coalesce(${documentAnnotations.dueOn}, ${NO_DUE_DATE}::date)`

function orderBy(order: ProjectMarkOrder): SQL[] {
  const byDocument = [asc(nameKey), asc(documents.id), asc(documentAnnotations.number)]
  return order === 'due' ? [asc(dueKey), ...byDocument] : byDocument
}

/** Rows strictly after `cursor` in `order`, as one row comparison so the keys cannot be compared one way and sorted another. */
function after(order: ProjectMarkOrder, cursor: ProjectMarkCursor): SQL {
  const byDocument = sql`${nameKey}, ${documents.id}, ${documentAnnotations.number}`
  const bound = sql`${cursor.name}::text, ${cursor.documentId}::uuid, ${cursor.number}::integer`
  return order === 'due'
    ? sql`(${dueKey}, ${byDocument}) > (${cursor.due}::date, ${bound})`
    : sql`(${byDocument}) > (${bound})`
}

function dueWhere(due: DueRange | null | undefined): SQL[] {
  if (!due) return []
  if ('before' in due) return [lt(documentAnnotations.dueOn, due.before)]
  return [gte(documentAnnotations.dueOn, due.from), lte(documentAnnotations.dueOn, due.through)]
}

const clampLimit = (limit: number) => Math.min(Math.max(1, Math.trunc(limit)), MAX_PROJECT_MARKS_PAGE)

/** What a page and its whole selection share: the project's documents as its listing narrows them, and the filters. */
type SelectionQuery = Omit<ProjectAnnotationPageQuery, 'order' | 'cursor' | 'limit'>

/** The WHERE of the selection, every page alike: the listing's narrowing, the reader's hold, the filters. */
function selectionWhere(organizationId: string, projectId: string, query: SelectionQuery): (SQL | undefined)[] {
  return [
    eq(documentAnnotations.organizationId, organizationId),
    shelfDocumentWhere(projectShelf(projectId), organizationId),
    eq(documents.lifecycle, 'active'),
    ...outsideHiddenFolders(query.hiddenFolderIds),
    documentVisibleTo(query.reader),
    inArray(documentAnnotations.status, [...query.statuses]),
    ...(query.assigneeUserId ? [eq(documentAnnotations.assigneeUserId, query.assigneeUserId)] : []),
    ...dueWhere(query.due),
  ]
}

/**
 * Whether any mark of the whole selection (every page of it, the filters
 * applied) sits on a document not every member of the project may open: one
 * filed in `restrictedFolderIds` (`getRestrictedFolderIds`), or an upload still
 * held back (ADR-0086), which only its uploader and its reviewers see. Its
 * Protokoll quotes those marks, so it must not be filed where every member
 * reads it. One `EXISTS`-shaped read, a row at most.
 */
export async function selectionReachesRestrictedDocuments(
  organizationId: string,
  projectId: string,
  query: SelectionQuery & { restrictedFolderIds: readonly string[] }
): Promise<boolean> {
  const db = getDb()
  const restricted = or(
    ...(query.restrictedFolderIds.length > 0 ? [inArray(documents.folderId, [...query.restrictedFolderIds])] : []),
    not(documentVisibleTo(SCREENED_ONLY) ?? sql`true`)
  )
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ id: documentAnnotations.id })
      .from(documentAnnotations)
      .innerJoin(documents, eq(documents.id, documentAnnotations.documentId))
      .where(and(...selectionWhere(organizationId, projectId, query), restricted))
      .limit(1)
  )
  return rows.length > 0
}

/**
 * One page of the project's Anmerkungen with these statuses, each with its
 * thread (bounded per mark, `withThreads`), its Fassung's number and both ends
 * of a carry, and the document row it sits on. Ordered by the document's name
 * and the mark's number, or by the Frist first (`order`); keyset-paged, so a
 * mark set between two reads neither repeats a row nor drops one.
 */
export async function listProjectAnnotationPage(
  organizationId: string,
  projectId: string,
  query: ProjectAnnotationPageQuery
): Promise<ProjectAnnotationPage> {
  const limit = clampLimit(query.limit)
  const db = getDb()
  const joins = carryJoins(organizationId)
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ ...selection, document: documents, sortName: nameKey })
      .from(documentAnnotations)
      .innerJoin(documents, eq(documents.id, documentAnnotations.documentId))
      .leftJoin(documentVersions, eq(documentVersions.id, documentAnnotations.versionId))
      .leftJoin(carriedSource, joins.source)
      .leftJoin(carriedCopy, joins.copy)
      .where(
        and(
          ...selectionWhere(organizationId, projectId, query),
          ...(query.cursor ? [after(query.order, query.cursor)] : [])
        )
      )
      .orderBy(...orderBy(query.order))
      .limit(limit + 1)
  )
  const page = rows.slice(0, limit)
  // `withThreads` keeps the order it was given, so each record is its row's.
  const records = (await withThreads(organizationId, page)).map((record, index) => ({
    ...record,
    document: page[index].document,
  }))
  const last = page.at(-1)
  const next =
    rows.length > limit && last
      ? {
          due: last.row.dueOn ?? NO_DUE_DATE,
          name: String(last.sortName),
          documentId: last.document.id,
          number: Number(last.row.number),
        }
      : null
  return { records, next }
}
