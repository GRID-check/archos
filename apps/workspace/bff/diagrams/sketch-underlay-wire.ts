/**
 * The wire of a Skizze traced over a PDF page (S6, ADR-0150), shared by the
 * routes, the agent catalog and the browser's client:
 *
 *   - `GET …/versions/[versionId]/pages/[page]/raster?dpi=` (`document-page-raster-get`): the page as a PNG;
 *   - `POST …/versions/[versionId]/pages/[page]/sketch` (`document-sketch-from-page`): a new Skizze on that page;
 *   - `GET` and `POST /api/documents/[id]/sketch/underlay` (`document-sketch-underlay-get`,
 *     `document-sketch-underlay-move`): what moving a Skizze to the base's newer Fassung would do, and doing it.
 */

import { z } from 'zod'
import { DEFAULT_PAGE_RASTER_DPI, PAGE_RASTER_DPIS } from '@/lib/documents/page-raster-limits'
import type { SketchUnderlay } from './sketch-underlay'

const dpi = z.coerce
  .number()
  .int()
  .refine((value) => (PAGE_RASTER_DPIS as readonly number[]).includes(value), `one of ${PAGE_RASTER_DPIS.join(', ')}`)
  .optional()
  .describe(`Resolution of the page: ${PAGE_RASTER_DPIS.join(', ')} dpi (default ${DEFAULT_PAGE_RASTER_DPI}); the long side is at most 4096 px.`)

export const pageRasterQuerySchema = z.object({ dpi })

export const pageParamsShape = {
  versionId: z.string().describe('The version id, from document-version-list.'),
  page: z.coerce.number().int().min(1).max(9999).describe('The page, from 1.'),
}

export const sketchFromPageSchema = z.object({ dpi })
export type SketchFromPageBody = z.infer<typeof sketchFromPageSchema>

export const underlayMoveSchema = z.object({
  baseVersionId: z
    .string()
    .min(1)
    .max(64)
    .nullable()
    .describe('The Skizze’s `versionId` from document-sketch-get; a newer one answers 409.'),
  versionId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('The base document’s version to move to; default its current one.'),
  page: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .optional()
    .describe('Page to move to, after `label_ambiguous`.'),
})
export type UnderlayMoveBody = z.infer<typeof underlayMoveSchema>

export const underlayPlanQuerySchema = z.object({
  versionId: z.string().min(1).max(64).optional().describe('The base document’s version to move to; default its current one.'),
  page: z.coerce.number().int().min(1).max(9999).optional().describe('A chosen page, after `label_ambiguous`.'),
})

/** The page a Skizze lies on, as one reader sees it. */
export type SketchUnderlayView =
  | { state: 'unavailable'; elementId: string; ref: SketchUnderlay }
  | {
      state: 'available'
      elementId: string
      ref: SketchUnderlay
      /** The base document's name, as this reader sees it. */
      title: string
      versionNumber: number
      /** The base's current Fassung when it is another one than the underlay's: the editor offers the move. */
      newer: { versionId: string; versionNumber: number } | null
    }

/** One end of a move. */
export interface UnderlayPage {
  versionId: string
  versionNumber: number
  page: number
  pageLabel: string | null
}

/** What `GET …/sketch/underlay` answers, and the move answers beside the saved Fassung. */
export interface UnderlayMovePlan {
  from: UnderlayPage
  to: UnderlayPage
  /** How the page was found again: by its label in the PDF (`A-101`), by its number, or as the person chose. */
  matchedBy: 'label' | 'index' | 'chosen'
  /** The old page had a label the newer Fassung does not name: matched by its number instead, and the dialog says so. */
  labelGone: boolean
}
