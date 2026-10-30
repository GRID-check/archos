/**
 * The SQL over `annotation_viewpoints` (migration 0193): a viewpoint and the
 * mark that names it are written together, a viewpoint is read for the
 * document it belongs to, and a list of marks carries a short summary of each.
 *
 * No authorization here; the service owns that. Every read is keyed by a
 * document the service already loaded through its reader, or joins `documents`
 * behind the reader's `documentVisibleTo` ({@link findMissingElements}).
 */

import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { annotationViewpoints, type AnnotationViewpointRow } from '@/lib/db/schema/annotation-viewpoints'
import { bimElements, bimModels } from '@/lib/db/schema/bim'
import { documentAnnotations, type DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import { documents } from '@/lib/db/schema/documents'
import { withTenant } from '@/lib/db/tenant-context'
import { documentVisibleTo, type DocumentReader } from '@/lib/documents/visibility'
import { allocateNumbers } from './numbering'
import type { NewAnnotationValues } from './repository'
import type { ViewpointSummary } from './viewpoint-types'

/** The fields of a viewpoint row a request decides; the rest is the table's. */
export type NewViewpointValues = Pick<
  typeof annotationViewpoints.$inferInsert,
  | 'id'
  | 'cameraKind'
  | 'camera'
  | 'clippingPlanes'
  | 'selectionIds'
  | 'defaultVisibility'
  | 'visibilityExceptionIds'
  | 'coloring'
  | 'pinPoint'
  | 'pinGlobalId'
  | 'snapshotKey'
  | 'snapshotContentType'
  | 'snapshotBytes'
>

/** What a mark on a model says; it has no box. */
export type ViewpointMarkContent = Pick<
  NewAnnotationValues,
  'kind' | 'body' | 'mentions' | 'basis' | 'assigneeUserId' | 'dueOn'
>

/**
 * A mark on a model and its viewpoint, in ONE transaction under the tenant
 * context: the number allocated as for any mark (`./numbering.ts`), the
 * viewpoint inserted, then the mark with `anchor_kind = 'viewpoint'` and no
 * box. A person's mark is born `open`.
 */
export async function insertViewpointMark(input: {
  organizationId: string
  documentId: string
  versionId: string | null
  createdBy: string
  viewpoint: NewViewpointValues
  mark: ViewpointMarkContent
}): Promise<DocumentAnnotationRow> {
  const { organizationId, documentId, versionId, createdBy } = input
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const number = await allocateNumbers(tx, organizationId, documentId, 1)
      await tx
        .insert(annotationViewpoints)
        .values({ ...input.viewpoint, organizationId, documentId, versionId, createdBy })
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
          status: 'open',
          createdBy,
        })
        .returning()
      return row
    })
  )
}

/** One viewpoint of one document, or null. The service read the document through its reader. */
export async function findViewpoint(
  organizationId: string,
  documentId: string,
  viewpointId: string
): Promise<AnnotationViewpointRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(annotationViewpoints)
      .where(
        and(
          eq(annotationViewpoints.organizationId, organizationId),
          eq(annotationViewpoints.documentId, documentId),
          eq(annotationViewpoints.id, viewpointId)
        )
      )
      .limit(1)
  )
  return row ?? null
}

/** These viewpoints of one document, in one query. The service read the document through its reader. */
export async function findViewpoints(
  organizationId: string,
  documentId: string,
  viewpointIds: readonly string[]
): Promise<AnnotationViewpointRow[]> {
  if (viewpointIds.length === 0) return []
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(annotationViewpoints)
      .where(
        and(
          eq(annotationViewpoints.organizationId, organizationId),
          eq(annotationViewpoints.documentId, documentId),
          inArray(annotationViewpoints.id, [...viewpointIds])
        )
      )
      // A stable order, so a caller that walks the rows sees them the same way twice.
      .orderBy(asc(annotationViewpoints.id))
      .limit(viewpointIds.length)
  )
}

/** The short form of each of these viewpoints, in one query, keyed by viewpoint id. */
export async function viewpointSummariesFor(
  organizationId: string,
  documentId: string,
  viewpointIds: readonly string[]
): Promise<Map<string, ViewpointSummary>> {
  if (viewpointIds.length === 0) return new Map()
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        id: annotationViewpoints.id,
        cameraKind: annotationViewpoints.cameraKind,
        selectionIds: annotationViewpoints.selectionIds,
        clippingPlanes: annotationViewpoints.clippingPlanes,
        snapshotKey: annotationViewpoints.snapshotKey,
      })
      .from(annotationViewpoints)
      .where(
        and(
          eq(annotationViewpoints.organizationId, organizationId),
          eq(annotationViewpoints.documentId, documentId),
          inArray(annotationViewpoints.id, [...viewpointIds])
        )
      )
      .limit(viewpointIds.length)
  )
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        cameraKind: row.cameraKind,
        selectionCount: row.selectionIds.length,
        hasSection: row.clippingPlanes.length > 0,
        hasSnapshot: row.snapshotKey !== null,
      },
    ])
  )
}

/**
 * Which of these GlobalIds the model of this document does not have, as
 * `reader` may see the document (ADR-0086). Bounded by what the caller asks.
 */
export async function findMissingElements(
  organizationId: string,
  modelId: string,
  globalIds: readonly string[],
  reader: DocumentReader
): Promise<string[]> {
  if (globalIds.length === 0) return []
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ globalId: bimElements.globalId })
      .from(bimElements)
      .innerJoin(bimModels, eq(bimModels.id, bimElements.modelId))
      .innerJoin(documents, eq(documents.id, bimModels.documentId))
      .where(
        and(
          eq(bimElements.modelId, modelId),
          eq(bimModels.organizationId, organizationId),
          inArray(bimElements.globalId, [...globalIds]),
          documentVisibleTo(reader)
        )
      )
      .limit(globalIds.length)
  )
  const present = new Set(rows.map((row) => row.globalId))
  return globalIds.filter((id) => !present.has(id))
}

/** The short form of each viewpoint these marks name, in one query (not a join: most documents have none). */
export const viewpointSummariesOfMarks = (
  organizationId: string,
  documentId: string,
  records: readonly { viewpointId: string | null }[]
) =>
  viewpointSummariesFor(
    organizationId,
    documentId,
    records.flatMap((record) => (record.viewpointId ? [record.viewpointId] : []))
  )
