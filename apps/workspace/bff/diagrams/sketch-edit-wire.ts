/**
 * The wire of a Skizze edit (`POST /api/documents/[id]/sketch/edits`, its
 * `/preview`, and `POST /api/documents/[id]/sketch/revert`): a short list of
 * operations on the elements of a filed sketch, applied by the server
 * (`sketch-edit.ts`) instead of a whole scene sent back. Shared by the routes,
 * the agent catalog (`bff/agent-api/catalog/documents.ts`) and the receipt
 * card (`ui/features/diagrams/sketch/sketch-edit-receipt.tsx`).
 *
 * The operations follow what a model gets right from an outline (the S4 eval,
 * `evals/sketch-edits/`) and tldraw's agent kit: absolute `add`, `update` and
 * `remove`, plus relative ones (`place`, `align`, `distribute`, `stack`) the
 * server turns into numbers, and `rebind` for an arrow's ends. Every operation
 * carries its `intent`, the step as the person reads it on the card.
 */

import { z } from 'zod'
import { SKETCH_ELEMENT_TYPES } from './sketch-fence'
import { sketchLinkSchema } from './sketch-links'

/** At most this many operations in one edit: a proposal a person reads through. */
export const MAX_SKETCH_EDIT_OPS = 60
export const MAX_SKETCH_EDIT_INTENT_CHARS = 200
export const MAX_SKETCH_EDIT_NOTE_CHARS = 500
/** The largest gap or offset a relative operation may ask for, in scene pixels. */
export const MAX_SKETCH_EDIT_GAP = 2_000

/** Ids, coordinates and the intent's length are bounded by the apply (`sketch-edit.ts`) and the scene check, not here: the schema is what every agent reads. */
const elementId = z.string()
/** The intent's words, bounded where the schema is read once (`add`) and checked for every op by the service. */
const intent = z.string()
const describedIntent = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SKETCH_EDIT_INTENT_CHARS)
  .describe('Every op has one: the step as the person reads it, one short sentence in their language.')
const coordinate = z.number()
const size = z.number().positive()
const gap = z.number().min(0).max(MAX_SKETCH_EDIT_GAP)

export const SKETCH_EDIT_SIDES = ['above', 'below', 'left', 'right'] as const
export const SKETCH_EDIT_ALIGNS = ['start', 'center', 'end'] as const
export const SKETCH_EDIT_EDGES = ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const
export const SKETCH_EDIT_AXES = ['horizontal', 'vertical'] as const

/** What `update` may set: geometry, style, the label or text, and the element's link (`customData`, `sketch-links.ts`). */
export const sketchEditSetSchema = z
  .object({
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: size.optional(),
    height: size.optional(),
    strokeColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']).optional(),
    strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
    label: z.object({ text: z.string().max(500) }).optional().describe('Empty removes it.'),
    text: z.string().min(1).max(500).optional(),
    customData: sketchLinkSchema
      .nullable()
      .optional()
      .describe('`documentId` + `page`, + `ifcGlobalId` (its IFC model), or + `annotationId`; null unlinks.'),
  })
  .strict()

const addOp = z.object({
  op: z.literal('add'),
  intent: describedIntent,
  element: z
    .looseObject({ type: z.enum(SKETCH_ELEMENT_TYPES), id: z.string().min(1).max(64) })
    .describe('A sketch fence element with a new `id`; bindings may name existing ones.'),
})
const updateOp = z.object({ op: z.literal('update'), intent, id: elementId, set: sketchEditSetSchema })
const removeOp = z
  .object({ op: z.literal('remove'), intent, id: elementId })

const rebindOp = z
  .object({ op: z.literal('rebind'), intent, id: elementId, start: elementId.optional(), end: elementId.optional() })

const placeOp = z
  .object({
    op: z.literal('place'),
    intent,
    id: elementId,
    referenceId: elementId,
    side: z.enum(SKETCH_EDIT_SIDES),
    offset: gap.optional(),
    align: z.enum(SKETCH_EDIT_ALIGNS).optional(),
  })

const alignOp = z.object({
  op: z.literal('align'),
  intent,
  ids: z.array(elementId).min(2),
  edge: z.enum(SKETCH_EDIT_EDGES),
})
const distributeOp = z
  .object({ op: z.literal('distribute'), intent, ids: z.array(elementId).min(3), axis: z.enum(SKETCH_EDIT_AXES) })

const stackOp = z
  .object({ op: z.literal('stack'), intent, ids: z.array(elementId).min(2), axis: z.enum(SKETCH_EDIT_AXES), gap: gap.optional() })


export const sketchEditOpSchema = z.discriminatedUnion('op', [addOp, updateOp, removeOp, rebindOp, placeOp, alignOp, distributeOp, stackOp])
export type SketchEditOp = z.infer<typeof sketchEditOpSchema>
export type SketchEditOpKind = SketchEditOp['op']

export const sketchEditSchema = z.object({
  baseVersionId: z
    .string()
    .min(1)
    .max(64)
    .nullable()
    .describe('The `versionId` document-sketch-get returned.'),
  ops: z.array(sketchEditOpSchema).max(MAX_SKETCH_EDIT_OPS),
  note: z
    .string()
    .trim()
    .max(MAX_SKETCH_EDIT_NOTE_CHARS)
    .optional()
    .describe('For the person; with no ops, why nothing changes.'),
})
export type SketchEditBody = z.infer<typeof sketchEditSchema>

export const sketchRevertSchema = z.object({
  versionId: z.string().min(1).max(64).describe('The current version, to take back.'),
})
export type SketchRevertBody = z.infer<typeof sketchRevertSchema>

/** A layout problem the edit would leave; the edit is still valid. */
export const SKETCH_EDIT_WARNINGS = ['overlap', 'label-overflow', 'outside-frame', 'unbound-arrow', 'dimension-label'] as const
export type SketchEditWarningKind = (typeof SKETCH_EDIT_WARNINGS)[number]

export interface SketchEditWarning {
  kind: SketchEditWarningKind
  /** The elements it is about, the moved or added one first. */
  ids: string[]
}

/** Which elements an edit adds, removes and changes, by id. */
export interface SketchEditDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

/** What a preview answers: the change, and its picture drawn by the server. */
export interface SketchEditPreview {
  documentId: string
  baseVersionId: string
  diff: SketchEditDiff
  warnings: SketchEditWarning[]
  /** The before and after in one picture (`sketch-edit-diff.ts`): added green, removed dashed red, changed blue over dashed grey. */
  svg: string
}

/** What an applied edit answers: the saved Fassung, and what the edit did. */
export interface AppliedSketchEdit {
  documentId: string
  versionId: string
  versionNumber: number
  state: 'published' | 'draft'
  /** True when the edit was applied on a newer Fassung than `baseVersionId`, every id it names still drawn there. */
  rebased: boolean
  diff: SketchEditDiff
  warnings: SketchEditWarning[]
  pdfStale: boolean
}

/** What an edit with no operations answers: nothing changed, the note says why. */
export interface DeclinedSketchEdit {
  declined: true
  note: string
}
