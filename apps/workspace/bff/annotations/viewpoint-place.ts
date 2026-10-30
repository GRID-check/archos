/**
 * Where a new mark goes on a model: a viewpoint (migration 0193). Parallel to
 * `./sketch-place.ts`, which does the same for a Skizze.
 *
 * The rules, each a refusal the caller can act on:
 *
 *   - **A viewpoint only on a model** (400 `not_a_model`): a document with no
 *     `bim_models` row, as the reader may see it, has no 3D to look at.
 *   - **A box or elements never on a model** (422): „A mark on a model sets a
 *     viewpoint.“ A box on a model has no page to sit on.
 *   - **A model that is ready** (422 `model_not_ready`): its element list is
 *     what the selection is checked against.
 *   - **Elements that exist** (422 `unknown_elements`, the first 20 missing):
 *     the selection and the pin's element must be GlobalIds of this model.
 *     Skipped when the model's element list is truncated, because a missing id
 *     may be in the part not stored. Visibility exceptions and colouring are
 *     format-checked only: they may name elements the viewer holds that the
 *     index dropped.
 *   - **A snapshot that is an image** (422 `bad_snapshot`, `./viewpoint-snapshot.ts`).
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { BadRequestError, UnprocessableError } from '@/lib/api/errors'
import { findBimModelByDocument } from '@/lib/bim/repository'
import { isIfcFilename } from '@/lib/bim/types'
import type { Document } from '@/lib/db/schema/documents'
import type { DocumentReader } from '@/lib/documents/visibility'
import { namesElements, namesViewpoint } from './place'
import type { PlacedInput } from './sketch-place'
import { findMissingElements, type NewViewpointValues, type ViewpointMarkContent } from './viewpoint-repository'
import { snapshotUploadFor, type SnapshotUpload } from './viewpoint-snapshot'
import type { ParsedViewpointInput } from './viewpoint-types'

/** How many missing GlobalIds a refusal names. */
export const MAX_REPORTED_MISSING = 20

/** A mark on a model as the request names it: a viewpoint and the mark's own fields. */
export type ViewpointMarkInput = PlacedInput & { viewpoint: ParsedViewpointInput }

/** The rows a viewpoint mark is made of, and the snapshot object that goes with them. */
export interface PlacedViewpoint {
  viewpoint: NewViewpointValues
  mark: ViewpointMarkContent
  snapshot: SnapshotUpload | null
}

/** Whether a document's name says it is a model: the cheap test before the lookup. */
const looksLikeModel = (doc: Pick<Document, 'filename'>) => isIfcFilename(doc.filename)

/** A model's header as this reader may see its document, or null. */
const modelOf = (doc: Document, reader: DocumentReader) => findBimModelByDocument(doc.id, doc.organizationId, reader)

/**
 * A box or elements on a model are refused: a mark there sets a viewpoint. A
 * document whose name does not say it is a model is not looked up.
 */
export async function refuseBoxOnModel(doc: Document, reader: DocumentReader): Promise<void> {
  if (!looksLikeModel(doc)) return
  if (await modelOf(doc, reader)) {
    throw new UnprocessableError('A mark on a model sets a viewpoint: send viewpoint, not a box or elementIds.')
  }
}

/** Whether a request names a box or elements, which a model does not take. */
export const namesBoxOrElements = (input: PlacedInput) =>
  namesElements(input) || input.page != null || input.shape != null

/** The GlobalIds a viewpoint's selection and pin need to exist in the model. */
export const elementsToExist = (viewpoint: ParsedViewpointInput): string[] => {
  const pinned = viewpoint.pin?.globalId
  return [...new Set([...viewpoint.components.selection.globalIds, ...(pinned ? [pinned] : [])])]
}

/** The viewpoint row for a request, ids and bounds as the CHECKs hold them. */
export function viewpointValues(id: string, viewpoint: ParsedViewpointInput, snapshot: SnapshotUpload | null): NewViewpointValues {
  const { components } = viewpoint
  return {
    id,
    cameraKind: viewpoint.camera.type,
    camera: viewpoint.camera,
    clippingPlanes: viewpoint.clippingPlanes,
    selectionIds: components.selection.globalIds,
    defaultVisibility: components.visibility.defaultVisibility,
    visibilityExceptionIds: components.visibility.exceptions,
    coloring: components.coloring,
    pinPoint: viewpoint.pin?.point ?? null,
    pinGlobalId: viewpoint.pin?.globalId ?? null,
    snapshotKey: snapshot?.key ?? null,
    snapshotContentType: snapshot?.contentType ?? null,
    snapshotBytes: snapshot?.body.length ?? null,
  }
}

/** The mark's own fields; a viewpoint mark has no box. */
export const viewpointMarkContent = (input: PlacedInput): ViewpointMarkContent => ({
  kind: input.kind,
  body: input.body,
  mentions: input.mentions ?? [],
  basis: input.basis ?? null,
  assigneeUserId: input.assigneeUserId ?? null,
  dueOn: input.dueOn ?? null,
})

/**
 * Check a viewpoint request against the document and its model, and make the
 * rows. Nothing is written: the snapshot is stored by the caller after this
 * returns, and before the transaction.
 */
export async function placeViewpoint(doc: Document, input: ViewpointMarkInput, reader: DocumentReader): Promise<PlacedViewpoint> {
  if (!namesViewpoint(input) || namesBoxOrElements(input)) {
    throw new BadRequestError('Give exactly one of a box, elementIds or a viewpoint.')
  }
  const model = looksLikeModel(doc) ? await modelOf(doc, reader) : null
  if (!model) {
    throw new BadRequestError('A viewpoint belongs on a 3D model; this document is not one.', { reason: 'not_a_model' })
  }
  if (model.status !== 'ready') {
    throw new UnprocessableError('The model is not ready yet. Set the mark when its status is ready.', {
      reason: 'model_not_ready',
    })
  }
  const wanted = elementsToExist(input.viewpoint)
  if (model.summary?.truncatedAt == null) {
    const missing = await findMissingElements(doc.organizationId, model.id, wanted, reader)
    if (missing.length > 0) {
      throw new UnprocessableError('These elements are not in the model.', {
        reason: 'unknown_elements',
        missing: missing.slice(0, MAX_REPORTED_MISSING),
      })
    }
  }
  const id = randomUUID()
  const snapshot = input.viewpoint.snapshot ? snapshotUploadFor(doc, id, input.viewpoint.snapshot) : null
  return { viewpoint: viewpointValues(id, input.viewpoint, snapshot), mark: viewpointMarkContent(input), snapshot }
}
