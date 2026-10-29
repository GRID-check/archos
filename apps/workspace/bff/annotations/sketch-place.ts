/**
 * Where a new mark goes on its document: a box on a page, or the elements of a
 * Skizze it is about, whose box the server derives (migration 0192).
 *
 * The rules, each a refusal the caller can act on:
 *
 *   - **On a Skizze a mark names elements.** A box there would sit over empty
 *     paper after the next save, so a box is refused (422) and the elements
 *     are asked for. The ids are Excalidraw's, as `GET …/sketch` lists them.
 *   - **Elements only on a Skizze.** Anywhere else a mark is a box on a page
 *     (400).
 *   - **The elements of the published Fassung.** The box is drawn from the
 *     scene the document's current bytes carry; an element drawn after the last
 *     save is not in it yet (422, „save first").
 *
 * The mark then lands on page 1 as a region, the CHECK
 * `…_anchor_is_region_on_sheet`.
 */

import 'server-only'
import { BadRequestError, UnprocessableError } from '@/lib/api/errors'
import type { Document } from '@/lib/db/schema/documents'
import { publishedSketchOf, type PublishedSketch } from '@/lib/diagrams/sketch-document'
import { namesElements } from './place'
import type { NewAnnotationValues } from './repository'
import { elementRegion, presentIds } from './sketch-anchor'
import type { AnnotationShape, MarkMention } from './types'

/** A mark's fields as a request names its place: a box, or elements (never both, `./place.ts`). */
export type PlacedInput = {
  kind: NewAnnotationValues['kind']
  body: string
  mentions?: MarkMention[]
  basis?: string | null
  assigneeUserId?: string | null
  dueOn?: string | null
  page?: number
  shape?: AnnotationShape
  x?: number
  y?: number
  w?: number | null
  h?: number | null
  elementIds?: string[]
}

/** A box on a page; the request schema's refinement (`./place.ts`) guarantees it without elements. */
type BoxInput = PlacedInput & { page: number; shape: AnnotationShape; x: number; y: number }

/** The row's values for a mark: its place resolved to a box, and the elements it is pinned to, if any. */
export const toMark = (input: PlacedInput, sketch: PublishedSketch | null): NewAnnotationValues => {
  const { page, shape, x, y, w, h, anchorElementIds } = placeOf(input, sketch)
  return {
    page,
    shape,
    x,
    y,
    w: shape === 'region' ? (w ?? null) : null,
    h: shape === 'region' ? (h ?? null) : null,
    anchorElementIds,
    kind: input.kind,
    body: input.body,
    mentions: input.mentions ?? [],
    basis: input.basis ?? null,
    assigneeUserId: input.assigneeUserId ?? null,
    dueOn: input.dueOn ?? null,
  }
}

function placeOf(input: PlacedInput, sketch: PublishedSketch | null) {
  if (!namesElements(input)) {
    if (sketch) {
      throw new UnprocessableError(
        'A mark on a sketch is pinned to its elements: send elementIds (from document-sketch-get), not a box.'
      )
    }
    return { ...(input as BoxInput), anchorElementIds: null }
  }
  if (!sketch) throw new BadRequestError('Only a mark on a sketch names elements; on this document give a box on a page.')
  const ids = input.elementIds
  const missing = ids.filter((id) => !presentIds(sketch.scene.elements, ids).includes(id))
  const region = sketch.viewBox && missing.length === 0 ? elementRegion(sketch.scene, ids, sketch.viewBox) : null
  if (!region) {
    throw new UnprocessableError('These elements are not in the saved sketch. Save the sketch first, then set the mark.', {
      missing,
    })
  }
  return { page: 1, shape: 'region' as const, ...region, anchorElementIds: ids }
}

/** The Skizze a document is, read once for every mark of one request; null for any other document. */
export async function sketchOfDocument(doc: Document, inputs: readonly PlacedInput[]): Promise<PublishedSketch | null> {
  // A PDF is never a Skizze: its bytes are not read for it, unless a mark wrongly names elements.
  if (doc.contentType !== 'image/svg+xml') return null
  return publishedSketchOf(doc).then(
    (sketch) => sketch,
    (error: unknown) => {
      if (inputs.some(namesElements)) throw error
      return null
    }
  )
}
