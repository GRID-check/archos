/**
 * A sketch element's link into the workspace (S5, `docs/roadmap/sketches.md`):
 * an arrow to „Detail 4, Polierplan S. 12“, a bubble that is the Raum of the
 * model, a cloud that is an Anmerkung on another document.
 *
 * The link lives in the element's `customData`, Excalidraw's own field for data
 * an app keeps on an element, under the keys of {@link SKETCH_LINK_KEYS} and no
 * others. That one list is what every door keeps: the fence a model writes
 * (`sketch-fence.ts`, and `common/sketch_fence.py` which counts the same links,
 * held together by `__fixtures__/sketch-fences.json`), the scene a save stores
 * and the live wire (`sketch-scene.ts`, `withoutForeignFields`), and the edit
 * Piloti proposes (`sketch-edit-wire.ts`, `set.customData`). Excalidraw's own
 * `link` field stays dropped everywhere: it makes an element a click to any URL.
 *
 * A link is a pointer, the target is the record (research r2: Procore's lesson).
 * It stores ids only, never a title: who reads the sketch decides what they see
 * of the target (`sketch-link-resolve.ts`), and a title stored in the scene
 * would show a restricted document's name to everyone who can open the Skizze.
 *
 * Three kinds, told apart by which keys are set:
 *
 *   - `annotation`: `documentId` + `annotationId`, an Anmerkung on that document
 *     (a defect is an Anmerkung of kind `defect`; an Aufgabe is work handed to
 *     Piloti, and nothing to point a sketch at);
 *   - `ifcElement`: `documentId` + `ifcGlobalId`, the element of the model that
 *     document is, by IFC's own name for the id (BCF calls it IfcGuid);
 *   - `document`: `documentId`, optionally a `page` and a pinned `versionId`
 *     (absent: the current Fassung).
 *
 * A link is never a measurement: it says which thing is meant, and the sketch
 * still claims no dimension (ADR-0146).
 */

import { z } from 'zod'
import { isUuid } from '@/lib/ids'

/** The `customData` keys a sketch element may carry, the only ones every door keeps. */
export const SKETCH_LINK_KEYS = ['documentId', 'page', 'versionId', 'ifcGlobalId', 'annotationId'] as const
export type SketchLinkKey = (typeof SKETCH_LINK_KEYS)[number]

export const MAX_SKETCH_LINK_PAGE = 9999
/** IFC's GlobalId: 22 characters of its base-64 alphabet. */
export const IFC_GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/

/**
 * A document, version or Anmerkung id: a uuid, as the column stores it. Any
 * other string bound to a uuid column makes Postgres throw (22P02), so it is
 * refused at every door rather than reaching a query.
 */
const id = z.string().trim().toLowerCase().refine(isUuid, 'a uuid')

export const sketchLinkSchema = z
  .object({
    documentId: id,
    page: z.number().int().min(1).max(MAX_SKETCH_LINK_PAGE).optional(),
    versionId: id.optional(),
    ifcGlobalId: z.string().regex(IFC_GLOBAL_ID).optional(),
    annotationId: id.optional(),
  })
  .strict()
  .refine((link) => !(link.ifcGlobalId && link.annotationId), 'a link names one target: an element or an annotation')
  .refine((link) => !((link.ifcGlobalId || link.annotationId) && (link.page || link.versionId)), 'a page or a version belongs to a document link')

export type SketchLink = z.infer<typeof sketchLinkSchema>

export const SKETCH_LINK_KINDS = ['document', 'ifcElement', 'annotation'] as const
export type SketchLinkKind = (typeof SKETCH_LINK_KINDS)[number]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The `customData` an element keeps: the link keys of `value` when they make a
 * valid link, else nothing. A foreign key is dropped and the link kept; a link
 * whose value is wrong (a GlobalId of 21 characters, page 0) is dropped whole,
 * because a half link points somewhere nobody meant.
 */
export function keptSketchLink(value: unknown): SketchLink | undefined {
  if (!isObject(value)) return undefined
  // `null` reads as absent, as in `common/sketch_fence.py`: `{"page": null}` is a link without a page.
  const picked = Object.fromEntries(SKETCH_LINK_KEYS.filter((key) => value[key] != null).map((key) => [key, value[key]]))
  if (Object.keys(picked).length === 0) return undefined
  const parsed = sketchLinkSchema.safeParse(picked)
  return parsed.success ? parsed.data : undefined
}

export function sketchLinkKind(link: SketchLink): SketchLinkKind {
  if (link.annotationId) return 'annotation'
  if (link.ifcGlobalId) return 'ifcElement'
  return 'document'
}

/** One linked element as the outline lists it: which element, what kind, the stored ids. */
export interface SketchOutlineLink {
  elementId: string
  kind: SketchLinkKind
  ref: SketchLink
}

/** Where a resolved link leads in the app; the browser builds the address (`ui/features/documents/lib/sketch-link-href.ts`). */
export interface SketchLinkPlace {
  /** The shelf the target document lies on: a project's Dateien, or the Büroablage. */
  shelf: 'project' | 'office_shelf'
  projectId: string | null
  documentId: string
}

/**
 * A link as one reader sees it. `unavailable` covers both a target that is gone
 * and one this reader may not open, and says nothing more: no title, no reason,
 * so a link cannot tell anyone that a document they cannot see exists.
 */
export type ResolvedSketchLink =
  | (SketchOutlineLink & { state: 'unavailable' })
  | (SketchOutlineLink & {
      state: 'available'
      /** What the reader sees of the target: a document's name, an element's name and type, an Anmerkung's first words. */
      title: string
      place: SketchLinkPlace
      /** A document link: its page, and whether the pinned Fassung is still the current one. */
      page?: number
      versionNumber?: number
      current?: boolean
      /** An element link: the model's file name, which the viewer's `?model=` names it by. */
      modelFile?: string
      /** An Anmerkung link: its status and kind, read live, for the element's colour. */
      status?: 'proposed' | 'open' | 'resolved' | 'dismissed'
      annotationKind?: 'hint' | 'question' | 'defect'
    })

/** Every link a scene's drawn elements carry, in scene order. */
export function linksOf(elements: readonly { id: string; isDeleted?: boolean; customData?: unknown }[]): SketchOutlineLink[] {
  return elements.flatMap((element) => {
    if (element.isDeleted) return []
    const ref = keptSketchLink(element.customData)
    return ref ? [{ elementId: element.id, kind: sketchLinkKind(ref), ref }] : []
  })
}
