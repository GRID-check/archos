/**
 * The SQL of a BCF import (migration 0196): which topics a model already
 * carries, and one imported topic written as a mark on a viewpoint with its
 * thread, in one transaction.
 *
 * No authorization here; the service (`lib/bim/bcf-import-service.ts`) read
 * the document for writing first.
 */

import 'server-only'
import { and, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import { annotationViewpoints } from '@/lib/db/schema/annotation-viewpoints'
import { documentAnnotationReplies, documentAnnotations, type DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import { withTenant } from '@/lib/db/tenant-context'
import { allocateNumbers } from './numbering'
import { MAX_ANNOTATIONS_PER_DOCUMENT, type AnnotationStatus } from './types'
import type { NewViewpointValues, ViewpointMarkContent } from './viewpoint-repository'

/** Thrown when the topic is on the document already: the unique index refused a second mark for it. */
export class TopicImportedTwiceError extends Error {}

/** The topic guids the document's marks were imported from. Bounded: a document holds at most {@link MAX_ANNOTATIONS_PER_DOCUMENT} marks. */
export async function importedTopicGuids(organizationId: string, documentId: string): Promise<Set<string>> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ guid: documentAnnotations.sourceTopicGuid })
      .from(documentAnnotations)
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId),
          isNotNull(documentAnnotations.sourceTopicGuid)
        )
      )
      .limit(MAX_ANNOTATIONS_PER_DOCUMENT)
  )
  return new Set(rows.flatMap((row) => (row.guid ? [row.guid.toLowerCase()] : [])))
}

export interface ImportedReply {
  body: string
  /** Its author when the file's author is someone of this office who may open the document, else the importer. */
  createdBy: string
  /** When it arrived here: the import's time, in thread order. */
  createdAt: Date
  /** The comment's own date in the file, or null (the import's note, or a comment without one). */
  sourceDate: Date | null
}

export interface ImportedMarkInput {
  organizationId: string
  documentId: string
  versionId: string | null
  /** The person importing: the mark's author. */
  createdBy: string
  viewpoint: NewViewpointValues
  mark: ViewpointMarkContent & { status: Exclude<AnnotationStatus, 'proposed'> }
  sourceTopicGuid: string
  importBatchId: string
  replies: readonly ImportedReply[]
}

/**
 * One topic as a mark: the number allocated as for any mark (`./numbering.ts`,
 * which refuses past the document's cap with `AnnotationLimitReachedError`),
 * the viewpoint, the mark and its replies, all or nothing. A person's mark: a
 * topic closed in the file arrives closed by the importer, now
 * (`…_closing_complete`). Every reply carries the batch and the importer
 * (`document_annotation_replies_import_complete`), so a colleague's comment
 * from the file never reads as written here. A second mark for the same topic
 * on the same document is a {@link TopicImportedTwiceError}.
 */
export async function insertImportedMark(input: ImportedMarkInput): Promise<DocumentAnnotationRow> {
  const { organizationId, documentId, versionId, createdBy } = input
  const closed = input.mark.status !== 'open'
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const number = await allocateNumbers(tx, organizationId, documentId, 1)
      await tx.insert(annotationViewpoints).values({ ...input.viewpoint, organizationId, documentId, versionId, createdBy })
      const [row] = await tx
        .insert(documentAnnotations)
        .values({
          ...input.mark,
          mentions: input.mark.mentions ?? [],
          organizationId,
          documentId,
          versionId,
          number,
          anchorKind: 'viewpoint',
          viewpointId: input.viewpoint.id,
          page: null,
          shape: null,
          x: null,
          y: null,
          w: null,
          h: null,
          authorKind: 'person',
          createdBy,
          ...(closed ? { closedBy: createdBy, closedAt: new Date() } : {}),
          sourceTopicGuid: input.sourceTopicGuid,
          importBatchId: input.importBatchId,
        })
        .returning()
      if (input.replies.length > 0) {
        await tx.insert(documentAnnotationReplies).values(
          input.replies.map((reply) => ({
            organizationId,
            annotationId: row.id,
            authorKind: 'person' as const,
            body: reply.body,
            createdBy: reply.createdBy,
            createdAt: reply.createdAt,
            sourceDate: reply.sourceDate,
            importBatchId: input.importBatchId,
            importedBy: createdBy,
          }))
        )
      }
      return row
    })
  ).catch((error: unknown) => {
    if (isUniqueViolation(error, 'uniq_document_annotations_source_topic')) throw new TopicImportedTwiceError()
    throw error
  })
}
