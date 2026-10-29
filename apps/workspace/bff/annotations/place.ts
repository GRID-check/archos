/**
 * Where a mark goes: a box on a page, or the elements of a Skizze it is about
 * (migration 0192). The request schemas in `./types.ts` are built from these.
 *
 * A mark on a page of a PDF names its place as a share of the page: a point,
 * or a region. A mark on a Skizze names elements instead, and its box is the
 * server's to derive from the published scene (`./sketch-anchor.ts`), so it
 * follows them from one Fassung to the next. A client or an agent never sends
 * a box for a Skizze, and never sends elements for anything else
 * (`./sketch-place.ts` holds both rules).
 */

import { z } from 'zod'

/** A point, or a region dragged out on the page. */
export const ANNOTATION_SHAPES = ['point', 'region'] as const
export type AnnotationShape = (typeof ANNOTATION_SHAPES)[number]

/** How many elements of a Skizze one mark may be about (the CHECK `…_anchor_elements_bounded`). */
export const MAX_ANCHOR_ELEMENTS = 20

/** A share of the page, top-left origin: the `PageRegion` frame. */
export const unit = z.number().finite().min(0).max(1)

/** The place fields of a mark on a page: a page, and a point or a region on it. */
export const boxPlaceFields = {
  page: z.number().int().min(1).max(100_000),
  shape: z.enum(ANNOTATION_SHAPES),
  x: unit,
  y: unit,
  w: unit.nullable().optional(),
  h: unit.nullable().optional(),
}

/** The elements of a Skizze a mark is about, by their Excalidraw ids, each once. */
export const elementIdsSchema = z
  .array(z.string().min(1).max(128))
  .min(1)
  .max(MAX_ANCHOR_ELEMENTS)
  .refine((ids) => new Set(ids).size === ids.length, 'each element once')

type PlaceInput = {
  shape: AnnotationShape
  x: number
  y: number
  w?: number | null
  h?: number | null
}

/** A point has no size; a region has one and stays on its page (the CHECK `…_region_on_page`). */
export function placeProblem(place: PlaceInput): string | null {
  if (place.shape === 'point') return place.w != null || place.h != null ? 'a point has no size' : null
  if (!place.w || !place.h) return 'a region needs a size'
  if (place.x + place.w > 1.000001 || place.y + place.h > 1.000001) return 'a region stays on its page'
  return null
}

const checkPlace = (value: PlaceInput, context: z.RefinementCtx) => {
  const problem = placeProblem(value)
  if (problem) context.addIssue({ code: 'custom', message: problem })
}

/** A mark's own fields on a box on a page, checked: a point has no size, a region stays on its page. */
export const boxPlaced = <T extends z.ZodRawShape>(content: T) =>
  z
    .object({ ...boxPlaceFields, ...content })
    .strict()
    .superRefine((value, context) => checkPlace(value as PlaceInput, context))

const BOX_FIELDS = ['page', 'shape', 'x', 'y', 'w', 'h'] as const

/**
 * Either place: a box on a page, or `elementIds` of a Skizze and no box. One
 * object rather than a union, so the schema an agent reads names each field
 * once; the refinement holds the either-or.
 */
export const placed = <T extends z.ZodRawShape>(content: T) =>
  z
    .object({
      ...boxPlaceFields,
      page: boxPlaceFields.page.optional(),
      shape: boxPlaceFields.shape.optional(),
      x: unit.optional(),
      y: unit.optional(),
      elementIds: elementIdsSchema.optional(),
      ...content,
    })
    .strict()
    .superRefine((value, context) => {
      const place = value as Partial<PlaceInput> & { page?: number; elementIds?: string[] }
      if (place.elementIds) {
        if (BOX_FIELDS.some((field) => place[field as keyof typeof place] != null)) {
          context.addIssue({ code: 'custom', message: 'elementIds go without a box: the server derives it' })
        }
        return
      }
      if (place.page == null || place.shape == null || place.x == null || place.y == null) {
        context.addIssue({ code: 'custom', message: 'give page, shape, x and y, or elementIds on a sketch' })
        return
      }
      checkPlace(place as PlaceInput, context)
    })

/** Whether a parsed request names elements rather than a box. */
export const namesElements = <T extends object>(input: T): input is T & { elementIds: string[] } =>
  'elementIds' in input && Array.isArray((input as { elementIds?: unknown }).elementIds)
