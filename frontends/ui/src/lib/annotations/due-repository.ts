/**
 * The marks the daily reminder of a Zuständige's Frist reads
 * (`./due-reminders.ts`): open, with a Zuständige and a date on or before a
 * day, on a document that carries marks, is in the working set and passed
 * screening. A held upload is reminded of by nobody, as it is told to nobody
 * (`SCREENED_ONLY`, ADR-0086). Both reads take the partial index of migration
 * 0151 (`idx_document_annotations_due`).
 */

import 'server-only'
import { and, asc, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documentAnnotations, documents } from '@/lib/db/schema'
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

const dueThrough = (through: string) =>
  and(
    eq(documentAnnotations.status, 'open'),
    isNotNull(documentAnnotations.assigneeUserId),
    isNotNull(documentAnnotations.dueOn),
    lte(documentAnnotations.dueOn, through),
    eq(documents.lifecycle, 'active'),
    inArray(documents.scope, ['project', 'archiv']),
    documentVisibleTo(SCREENED_ONLY)
  )

const onItsDocument = and(
  eq(documents.id, documentAnnotations.documentId),
  eq(documents.organizationId, documentAnnotations.organizationId)
)

/**
 * The organizations with at least one mark due on or before `through`, by id,
 * at most `limit`. Discovery for the daily sweep, which runs it under the
 * platform scope and then works inside each organization (`withTenant`).
 */
export async function listOrganizationsWithDueMarks(through: string, limit: number): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ organizationId: documentAnnotations.organizationId })
    .from(documentAnnotations)
    .innerJoin(documents, onItsDocument)
    .where(dueThrough(through))
    .orderBy(asc(documentAnnotations.organizationId))
    .limit(limit)
  return rows.map((row) => row.organizationId)
}

/** One page of an organization's marks due on or before `through`, by id after `after`, at most `limit`. */
export async function listDueMarksPage(
  organizationId: string,
  through: string,
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
          dueThrough(through),
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
