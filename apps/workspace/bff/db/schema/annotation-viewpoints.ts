import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  CAMERA_KINDS,
  MAX_CLIPPING_PLANES,
  MAX_SNAPSHOT_BYTES,
  MAX_VIEWPOINT_COLORINGS,
  MAX_VIEWPOINT_SELECTION,
  MAX_VISIBILITY_EXCEPTIONS,
  type CameraKind,
  type ClippingPlane,
  type ViewpointCamera,
  type ViewpointPin,
} from '@/lib/annotations/viewpoint-types'
import { documentVersions } from './document-versions'
import { documents } from './documents'

/** A jsonb column that must be an array no longer than `max`; `CASE`, because the length of a scalar is an error. */
const arrayBounded = (column: AnyPgColumn, max: number) =>
  sql`CASE WHEN jsonb_typeof(${column}) = 'array' THEN jsonb_array_length(${column}) <= ${sql.raw(String(max))} ELSE false END`

/**
 * `annotation_viewpoints` — the view a mark on a 3D model is anchored to
 * (migration 0193): camera, section planes, selected, hidden and coloured
 * elements, and a snapshot. Immutable: no code updates a row. A document fact
 * (every read is keyed by a document its reader's rule let through). All
 * coordinates are IFC world coordinates, Z-up, metres.
 */
export const annotationViewpoints = pgTable(
  'annotation_viewpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id'),
    cameraKind: text('camera_kind').$type<CameraKind>().notNull(),
    camera: jsonb('camera').$type<ViewpointCamera>().notNull(),
    clippingPlanes: jsonb('clipping_planes').$type<ClippingPlane[]>().notNull().default([]),
    selectionIds: text('selection_ids').array().notNull().default([]),
    defaultVisibility: boolean('default_visibility').notNull().default(true),
    visibilityExceptionIds: text('visibility_exception_ids').array().notNull().default([]),
    coloring: jsonb('coloring').$type<{ color: string; globalIds: string[] }[]>().notNull().default([]),
    pinPoint: jsonb('pin_point').$type<ViewpointPin['point']>(),
    pinGlobalId: text('pin_global_id'),
    /** The snapshot object under the document's `_bim/viewpoints/` prefix; swept with the document. */
    snapshotKey: text('snapshot_key'),
    snapshotContentType: text('snapshot_content_type'),
    snapshotBytes: integer('snapshot_bytes'),
    /** The viewpoint this one was carried from, on this document or on the one it replaced (migration 0195). */
    carriedFromId: uuid('carried_from_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idDocumentKey: unique('annotation_viewpoints_id_document_uniq').on(table.id, table.documentId),
    documentFk: foreignKey({
      name: 'annotation_viewpoints_document_fkey',
      columns: [table.documentId],
      foreignColumns: [documents.id],
    }).onDelete('cascade'),
    versionFk: foreignKey({
      name: 'annotation_viewpoints_version_fkey',
      columns: [table.versionId],
      foreignColumns: [documentVersions.id],
    }).onDelete('set null'),
    documentIdx: index('idx_annotation_viewpoints_document').on(table.documentId),
    carriedFromFk: foreignKey({
      name: 'annotation_viewpoints_carried_from_fkey',
      columns: [table.carriedFromId],
      foreignColumns: [table.id],
    }).onDelete('set null'),
    carriedFromIdx: index('idx_annotation_viewpoints_carried_from')
      .on(table.carriedFromId)
      .where(sql`${table.carriedFromId} IS NOT NULL`),
    carriedFromOther: check(
      'annotation_viewpoints_carried_from_other',
      sql`${table.carriedFromId} IS NULL OR ${table.carriedFromId} <> ${table.id}`
    ),
    organizationIdx: index('idx_annotation_viewpoints_organization_id').on(table.organizationId),
    cameraKindKnown: check(
      'annotation_viewpoints_camera_kind_known',
      sql`${table.cameraKind} IN (${sql.raw(CAMERA_KINDS.map((kind) => `'${kind}'`).join(', '))})`
    ),
    cameraIsObject: check(
      'annotation_viewpoints_camera_is_object',
      sql`CASE WHEN jsonb_typeof(${table.camera}) = 'object' THEN ${table.camera}->>'type' = ${table.cameraKind} ELSE false END`
    ),
    planesBounded: check('annotation_viewpoints_planes_bounded', arrayBounded(table.clippingPlanes, MAX_CLIPPING_PLANES)),
    selectionBounded: check(
      'annotation_viewpoints_selection_bounded',
      sql`cardinality(${table.selectionIds}) <= ${sql.raw(String(MAX_VIEWPOINT_SELECTION))} AND array_position(${table.selectionIds}, NULL) IS NULL`
    ),
    exceptionsBounded: check(
      'annotation_viewpoints_exceptions_bounded',
      sql`cardinality(${table.visibilityExceptionIds}) <= ${sql.raw(String(MAX_VISIBILITY_EXCEPTIONS))} AND array_position(${table.visibilityExceptionIds}, NULL) IS NULL`
    ),
    coloringBounded: check('annotation_viewpoints_coloring_bounded', arrayBounded(table.coloring, MAX_VIEWPOINT_COLORINGS)),
    pinComplete: check(
      'annotation_viewpoints_pin_complete',
      sql`${table.pinGlobalId} IS NULL OR ${table.pinPoint} IS NOT NULL`
    ),
    snapshotComplete: check(
      'annotation_viewpoints_snapshot_complete',
      sql`(${table.snapshotKey} IS NULL) = (${table.snapshotBytes} IS NULL) AND (${table.snapshotKey} IS NULL) = (${table.snapshotContentType} IS NULL)`
    ),
    snapshotBounded: check(
      'annotation_viewpoints_snapshot_bounded',
      sql`${table.snapshotBytes} IS NULL OR ${table.snapshotBytes} BETWEEN 1 AND ${sql.raw(String(MAX_SNAPSHOT_BYTES))}`
    ),
  })
)

export type AnnotationViewpointRow = typeof annotationViewpoints.$inferSelect
export type NewAnnotationViewpointRow = typeof annotationViewpoints.$inferInsert
