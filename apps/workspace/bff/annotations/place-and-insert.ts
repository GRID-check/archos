/**
 * Setting a mark: where it goes (a box on a page, the elements of a Skizze, or
 * a viewpoint of a model) and the insert that follows. The service decides
 * who may and what follows; this module is the branch on the anchor.
 *
 * A viewpoint mark stores its snapshot first, then inserts the viewpoint and
 * the mark in one transaction; when that fails the snapshot is deleted again.
 */

import 'server-only'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentAnnotationRow } from '@/lib/db/schema/document-annotations'
import type { Document } from '@/lib/db/schema/documents'
import { memberReader } from '@/lib/documents/visibility'
import { namesViewpoint } from './place'
import { insertDocumentAnnotations } from './repository'
import { sketchOfDocument, toMark, type PlacedInput } from './sketch-place'
import { insertViewpointMark } from './viewpoint-repository'
import { discardSnapshot, putSnapshot } from './viewpoint-snapshot'
import { placeViewpoint, refuseBoxOnModel, type PlacedViewpoint } from './viewpoint-place'

/** A person's mark as stored, and the viewpoint rows it was made with, when it is on a model. */
export interface InsertedMark {
  row: DocumentAnnotationRow
  placed: PlacedViewpoint | null
}

/** One mark a person sets, wherever the request puts it. A document's full count raises `AnnotationLimitReachedError`. */
export async function placeAndInsert(session: AuthorizedSession, doc: Document, input: PlacedInput): Promise<InsertedMark> {
  const reader = memberReader(session.userId)
  if (namesViewpoint(input)) {
    const placed = await placeViewpoint(doc, input, reader)
    if (placed.snapshot) await putSnapshot(placed.snapshot)
    const row = await insertViewpointMark({
      organizationId: session.organizationId,
      documentId: doc.id,
      versionId: doc.publishedVersionId ?? null,
      createdBy: session.userId,
      viewpoint: placed.viewpoint,
      mark: placed.mark,
    }).catch(async (error: unknown) => {
      if (placed.snapshot) await discardSnapshot(placed.snapshot)
      throw error
    })
    return { row, placed }
  }
  await refuseBoxOnModel(doc, reader)
  const sketch = await sketchOfDocument(doc, [input])
  const [row] = await insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'person',
    createdBy: session.userId,
    marks: [toMark(input, sketch)],
  })
  return { row, placed: null }
}

/**
 * Marks Piloti sets: proposals, or marks the asker asked for (`acceptedBy`).
 * On a box or elements only: a viewpoint is a person's act for now.
 */
export async function placeAndInsertForAgent(
  session: AuthorizedSession,
  doc: Document,
  inputs: readonly PlacedInput[],
  acceptedBy: string | null
): Promise<DocumentAnnotationRow[]> {
  if (inputs.some(namesViewpoint)) {
    throw new BadRequestError('Piloti does not set viewpoint marks yet: a person sets a mark on a model.', {
      reason: 'viewpoint_not_for_agent',
    })
  }
  await refuseBoxOnModel(doc, memberReader(session.userId))
  const sketch = await sketchOfDocument(doc, inputs)
  return insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'piloti',
    createdBy: session.userId,
    acceptedBy,
    marks: inputs.map((mark) => toMark(mark, sketch)),
  })
}

/** What the product event for a new mark says about its anchor: kinds and counts, never a word of it. */
export function anchorEventProperties(placed: PlacedViewpoint | null): Record<string, string | boolean | number> {
  if (!placed) return {}
  const { viewpoint } = placed
  return {
    anchor: 'viewpoint',
    has_snapshot: viewpoint.snapshotKey != null,
    selection_count: viewpoint.selectionIds?.length ?? 0,
    has_section: (viewpoint.clippingPlanes?.length ?? 0) > 0,
    camera_kind: viewpoint.cameraKind,
  }
}
