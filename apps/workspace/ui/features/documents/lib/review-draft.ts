/**
 * A mark not yet saved: where it goes. Its own module so the review hook does
 * not grow with each anchor (a page box, a Skizze's elements, a model's view).
 */

import type { AnnotationShape } from '@/lib/annotations/types'
import type { ViewpointInput } from '@/lib/annotations/viewpoint-types'

/** A place picked on a page and not yet saved: a point, or a region dragged out. */
export interface ReviewDraft {
  page: number
  shape: AnnotationShape
  x: number
  y: number
  w: number | null
  h: number | null
  /** On a Skizze: the elements it is about; the box is drawn until the server derives its own (`lib/annotations/sketch-place.ts`). */
  elementIds?: string[]
  /** On a model: the view the mark is set on; the box above is then a placeholder the wire drops (`placeOnWire`). */
  viewpoint?: ViewpointInput
}
