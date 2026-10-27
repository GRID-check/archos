/**
 * The marks the daily reminder of a Zuständige's Frist reads
 * (`./due-reminders.ts`): open, with a Zuständige and a date inside a window
 * of days, on a document that carries marks, is in the working set and passed
 * screening. A held upload is reminded of by nobody, as it is told to nobody
 * (`SCREENED_ONLY`, ADR-0086). The window bounds both reads from below as well
 * as above, so a mark whose Frist passed long ago neither reminds anyone nor
 * keeps its organization in the daily discovery. The partial index of
 * migration 0151 (`idx_document_annotations_due`, on `due_on` over the open
 * marks with a Zuständige and a date) holds exactly the rows the window
 * ranges over; whether a read takes it is the planner's call.
 */

import 'server-only'
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentAnnotations } from '@/lib/db/schema/document-annotations'
import { documents } from '@/lib/db/schema/documents'
import { withTenant } from '@/lib/db/tenant-context'
import { SCREENED_ONLY } from '@/lib/documents/document-reader'
import type { OpenableDocument } from '@/lib/documents/may-open'
import { documentVisibleTo } from '@/lib/documents/visibility'

/** One mark due, with the document facts its Zuständige's right to open it is asked by. */
export interface DueMark {
  id: string
  documentId: string
  number: number
  body: string
  assigneeUserId: string
  dueOn: string
  document: OpenableDocument & { id: string }
}

/** The days, `YYYY-MM-DD` and inclusive, whose Frist a run reminds of. */
export interface DueWindow {
  from: string
  through: string
}

const dueWithin = (window: DueWindow) =>
  and(
    eq(documentAnnotations.status, 'open'),
    isNotNull(documentAnnotations.assigneeUserId),
    isNotNull(documentAnnotations.dueOn),
    gte(documentAnnotations.dueOn, window.from),
    lte(documentAnnotations.dueOn, window.through),
    eq(documents.lifecycle, 'active'),
    inArray(documents.scope, ['project', 'office_shelf']),
    documentVisibleTo(SCREENED_ONLY)
  )

const onItsDocument = and(
  eq(documents.id, documentAnnotations.documentId),
  eq(documents.organizationId, documentAnnotations.organizationId)
)

/**
 * The organizations with at least one mark due within `window`, at most
 * `limit`. Discovery for the daily sweep, which runs it under the platform
 * scope and then works inside each organization (`withTenant`).
 *
 * In an order that changes with `day` (a hash of the organization and the
 * day), so when more organizations have marks due than `limit`, the ones left
 * out are a different set each day rather than the same tail for good. Not by
 * the earliest Frist: discovery cannot see which marks were reminded already
 * (that is on the inbox rows), so the offices with long-overdue, already
 * reminded marks would hold the head of the list every day.
 */
export async function listOrganizationsWithDueMarks(window: DueWindow, day: string, limit: number): Promise<string[]> {
  const rows = await getDb()
    .select({ organizationId: documentAnnotations.organizationId })
    .from(documentAnnotations)
    .innerJoin(documents, onItsDocument)
    .where(dueWithin(window))
    .groupBy(documentAnnotations.organizationId)
    .orderBy(sql`md5(${documentAnnotations.organizationId} || ${day})`, asc(documentAnnotations.organizationId))
    .limit(limit)
  return rows.map((row) => row.organizationId)
}

/** One page of an organization's marks due within `window`, by id after `after`, at most `limit`. */
export async function listDueMarksPage(
  organizationId: string,
  window: DueWindow,
  after: string | null,
  limit: number
): Promise<DueMark[]> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .select({
        id: documentAnnotations.id,
        documentId: documentAnnotations.documentId,
        number: documentAnnotations.number,
        body: documentAnnotations.body,
        assigneeUserId: documentAnnotations.assigneeUserId,
        dueOn: documentAnnotations.dueOn,
        scope: documents.scope,
        projectId: documents.projectId,
        folderId: documents.folderId,
        createdBy: documents.createdBy,
        status: documents.status,
        authoredBy: documents.authoredBy,
        screeningOutcome: documents.screeningOutcome,
        contentHash: documents.contentHash,
        screenedHash: documents.screenedHash,
      })
      .from(documentAnnotations)
      .innerJoin(documents, onItsDocument)
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          dueWithin(window),
          after ? gt(documentAnnotations.id, after) : undefined
        )
      )
      .orderBy(asc(documentAnnotations.id))
      .limit(limit)
  )
  return rows.flatMap(({ id, documentId, number, body, assigneeUserId, dueOn, ...document }) =>
    assigneeUserId && dueOn
      ? [{ id, documentId, number: Number(number), body, assigneeUserId, dueOn, document: { ...document, id: documentId } }]
      : []
  )
}
