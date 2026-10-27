/**
 * A project's Offene Punkte: the open Anmerkungen of every document of one
 * project, for the Jour fixe, which is held per project and not per document
 * (`GET /api/projects/{id}/annotations`).
 *
 * ## Who reads what
 *
 * The project first, through the one gate a project's Dateien goes through
 * (`requireProjectAccess(…, 'project:view')`, as `listDocumentsPage` asks it).
 * Then the documents, narrowed in the query exactly as that listing narrows
 * them (`./project-repository.ts`): the reader's folders (ADR-0087) and the
 * screening hold (ADR-0086, `shelfReaderFor`). A mark is listed here only on a
 * document the reader's Dateien would list.
 *
 * ## One view
 *
 * Each row is the view a document's own list carries
 * (`documentAnnotationViews`, the list projection of `./service.ts`), per
 * document with what THIS reader may do there (`canWriteDocument`), plus the
 * document's name. No second view shape: the review, the inline peek and this
 * page read the same fields.
 */

import 'server-only'
import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds, getRestrictedFolderIds } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Document } from '@/lib/db/schema'
import { canWriteDocument } from '@/lib/documents/can-write'
import { documentDisplayName } from '@/lib/documents/display-name'
import { addCalendarDays, calendarDayIn, OFFICE_TIME_ZONE } from '@/lib/format'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { inPool } from '@/lib/utils/in-pool'
import {
  listProjectAnnotationPage,
  selectionReachesRestrictedDocuments,
  type DueRange,
  type ProjectAnnotationRecord,
  type ProjectMarkCursor,
} from './project-repository'
import {
  ASSIGNEE_ME,
  DUE_SOON_DAYS,
  PROJECT_MARKS_CURSOR_MAX_LENGTH,
  type ProjectMarkDue,
  type ProjectMarkStatus,
  type ProjectMarksQuery,
  type ProjectMarksResponse,
  type ProjectMarkView,
} from './project-types'
import { annotationDirectory, documentAnnotationViews } from './service'
import { LIVE_ANNOTATION_STATUSES, type AnnotationStatus } from './types'

/** The statuses each `status` filter reads. */
const STATUSES: Record<ProjectMarkStatus, readonly AnnotationStatus[]> = {
  open: ['open'],
  proposed: ['proposed'],
  'all-live': LIVE_ANNOTATION_STATUSES,
}

/** How many documents of one page are projected at once: each asks the document's write rule. */
const DOCUMENTS_AT_ONCE = 8

/** The Frist a `due` filter means on the office's day `today`. Pure. */
export function dueRangeOf(due: ProjectMarkDue | undefined, today: string): DueRange | null {
  if (due === 'overdue') return { before: today }
  if (due === 'soon') return { from: today, through: addCalendarDays(today, DUE_SOON_DAYS) }
  return null
}

const cursorSchema = z.object({
  u: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  n: z.string().max(PROJECT_MARKS_CURSOR_MAX_LENGTH),
  d: z.guid(),
  k: z.number().int().min(0),
})

/** Opaque on the wire (base64url JSON), so no client parses it. */
export function encodeProjectMarkCursor(cursor: ProjectMarkCursor): string {
  return Buffer.from(
    JSON.stringify({ u: cursor.due, n: cursor.name, d: cursor.documentId, k: cursor.number }),
    'utf8'
  ).toString('base64url')
}

/** The cursor this module wrote, or a 400: a hand-edited cursor is refused, never put into a query unchecked. */
export function decodeProjectMarkCursor(encoded: string): ProjectMarkCursor {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    // Falls through to the refusal below.
  }
  const result = cursorSchema.safeParse(parsed)
  if (!result.success) throw new BadRequestError('Invalid cursor.', { field: 'cursor' })
  return { due: result.data.u, name: result.data.n, documentId: result.data.d, number: result.data.k }
}

/** The page's documents in the order they first appear, each with its marks. */
function byDocument(records: readonly ProjectAnnotationRecord[]): { doc: Document; records: ProjectAnnotationRecord[] }[] {
  const groups = new Map<string, { doc: Document; records: ProjectAnnotationRecord[] }>()
  for (const record of records) {
    const group = groups.get(record.documentId) ?? { doc: record.document, records: [] }
    group.records.push(record)
    groups.set(record.documentId, group)
  }
  return [...groups.values()]
}

/**
 * One page of the project's open points as this reader sees them, in the
 * page's order (by document and number, or by Frist), each row a document's
 * own list view with the document's name.
 */
export async function listProjectAnnotations(
  session: AuthorizedSession,
  projectId: string,
  query: ProjectMarksQuery,
  now: Date = new Date()
): Promise<ProjectMarksResponse> {
  await requireProjectAccess(session, projectId, 'project:view')
  const cursor = query.cursor ? decodeProjectMarkCursor(query.cursor) : null
  const [reader, hiddenFolderIds] = await Promise.all([
    shelfReaderFor(session, { scope: 'project', projectId }),
    getHiddenFolderIds(session, projectId),
  ])
  const selection = {
    reader,
    hiddenFolderIds,
    statuses: STATUSES[query.status],
    assigneeUserId: query.assignee === ASSIGNEE_ME ? session.userId : (query.assignee ?? null),
    due: dueRangeOf(query.due, calendarDayIn(OFFICE_TIME_ZONE, now)),
  }
  const page = await listProjectAnnotationPage(session.organizationId, projectId, {
    ...selection,
    order: query.order,
    cursor,
    limit: query.limit,
  })
  if (page.records.length === 0) return { marks: [], nextCursor: null, ...(cursor ? {} : { restricted: false }) }
  // The first page says whether the whole selection quotes a document not every member may open.
  const restricted = cursor
    ? undefined
    : await selectionReachesRestrictedDocuments(session.organizationId, projectId, {
        ...selection,
        restrictedFolderIds: await getRestrictedFolderIds(session.organizationId, projectId),
      })

  const names = await annotationDirectory(session.organizationId)
  const projected = await inPool(byDocument(page.records), DOCUMENTS_AT_ONCE, async ({ doc, records }) =>
    documentAnnotationViews(session, doc, records, { writable: await canWriteDocument(session, doc.id), names })
  )
  const views = new Map(projected.flat().map((view) => [view.id, view]))
  const marks: ProjectMarkView[] = page.records.flatMap((record) => {
    const view = views.get(record.id)
    return view ? [{ ...view, documentName: documentDisplayName(record.document) }] : []
  })
  return {
    marks,
    nextCursor: page.next ? encodeProjectMarkCursor(page.next) : null,
    ...(restricted === undefined ? {} : { restricted }),
  }
}
