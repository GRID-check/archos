/**
 * Reading the viewpoint of a mark on a model: the whole view
 * (`GET …/annotations/{id}/viewpoint`) and its snapshot image
 * (`GET …/annotations/{id}/snapshot`). Both are gated exactly like reading the
 * document: `getAccessibleDocument` (read), then the mark must be one of that
 * document's and be anchored to a viewpoint.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { AnnotationViewpointRow } from '@/lib/db/schema/annotation-viewpoints'
import { getAccessibleDocument } from '@/lib/documents/access'
import { findDocumentAnnotation } from './repository'
import { findViewpoint } from './viewpoint-repository'
import { readSnapshot } from './viewpoint-snapshot'
import type { SnapshotContentType, ViewpointResponse, ViewpointView } from './viewpoint-types'

export const toViewpointView = (row: AnnotationViewpointRow): ViewpointView => ({
  id: row.id,
  documentId: row.documentId,
  versionId: row.versionId,
  camera: row.camera,
  clippingPlanes: row.clippingPlanes,
  components: {
    selection: { globalIds: row.selectionIds },
    visibility: { defaultVisibility: row.defaultVisibility, exceptions: row.visibilityExceptionIds },
    coloring: row.coloring,
  },
  pin: row.pinPoint ? { point: row.pinPoint, ...(row.pinGlobalId ? { globalId: row.pinGlobalId } : {}) } : null,
  hasSnapshot: row.snapshotKey !== null,
  createdAt: row.createdAt.toISOString(),
})

async function viewpointOfMark(session: AuthorizedSession, documentId: string, annotationId: string) {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  const mark = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!mark?.viewpointId) throw new NotFoundError()
  const row = await findViewpoint(session.organizationId, doc.id, mark.viewpointId)
  if (!row) throw new NotFoundError()
  return { doc, row }
}

/** The full viewpoint of a mark, or 404 when the mark is not there for this reader or is not on a model. */
export async function readViewpoint(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string
): Promise<ViewpointResponse> {
  const { row } = await viewpointOfMark(session, documentId, annotationId)
  return { viewpoint: toViewpointView(row) }
}

/** The snapshot bytes of a mark's viewpoint, or 404 when it has none. */
export async function readViewpointSnapshot(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string
): Promise<{ bytes: Uint8Array; contentType: SnapshotContentType }> {
  const { doc, row } = await viewpointOfMark(session, documentId, annotationId)
  if (!row.snapshotKey || !row.snapshotContentType) throw new NotFoundError()
  const bytes = await readSnapshot(doc, row.snapshotKey)
  if (!bytes) throw new NotFoundError()
  return { bytes, contentType: row.snapshotContentType as SnapshotContentType }
}
