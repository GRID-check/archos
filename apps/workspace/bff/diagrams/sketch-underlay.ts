/**
 * The page a Skizze is traced over (S6, ADR-0150): one locked Excalidraw image
 * element at the bottom of the scene, whose `customData.underlay` names the
 * Fassung's page it shows, `{ documentId, versionId, page, dpi }`.
 *
 * **A reference, never bytes.** The scene carries no `files`: the editor loads
 * the page from the raster route (`GET …/versions/{v}/pages/{n}/raster`) with
 * the reader's rights, and a filing embeds the server's own cached PNG
 * (`sketch-underlay-svg.ts`). The `fileId` is derived from the tuple
 * ({@link underlayFileId}), so two canvases and the server agree on it without
 * a lookup.
 *
 * **One list, every door.** What an underlay element is, is decided here, and
 * every door asks this file: the stored scene (`sketch-scene.ts`, which refuses
 * any other image), the live wire (`sketch-room-types.ts`, through the same
 * check), the edit (`sketch-edit.ts`: an operation that moves, changes,
 * removes or binds to it is refused), the outline (it reports the underlay so
 * Piloti knows what the sketch is drawn on). The fence a model writes knows no
 * `image` type at all (`sketch-fence.ts`): Piloti cannot start an underlay in
 * this slice. A person starts one from a PDF page („Auf Seite zeichnen“), and an
 * outside agent through `document-sketch-from-page`, under the person's yes.
 *
 * **Locked and plain.** `locked: true`, no crop (the filed SVG would lose a
 * crop's mask and uncrop it), no angle, no flip, no link, at most one per scene,
 * and below every drawn element. A sketch still claims no dimension: the page
 * lies one scene pixel per PDF point, and nothing measures on it (ADR-0146).
 */

import { z } from 'zod'
import { PAGE_RASTER_DPIS } from '@/lib/documents/page-raster-limits'
import { isUuid } from '@/lib/ids'

export const UNDERLAY_DPIS = PAGE_RASTER_DPIS
export const MAX_UNDERLAY_PAGE = 9999
/** Underlays one scene may hold. One page per Skizze; a second is a second Skizze. */
export const MAX_UNDERLAYS = 1

const uuid = z.string().refine(isUuid, 'a uuid')

export const sketchUnderlaySchema = z
  .object({
    documentId: uuid,
    versionId: uuid,
    page: z.number().int().min(1).max(MAX_UNDERLAY_PAGE),
    dpi: z.union([z.literal(100), z.literal(150), z.literal(200)]),
  })
  .strict()
export type SketchUnderlay = z.infer<typeof sketchUnderlaySchema>

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `customData` an underlay element keeps: `{ underlay }` when it is valid, else nothing. */
export function keptUnderlayData(value: unknown): { underlay: SketchUnderlay } | undefined {
  if (!isObject(value)) return undefined
  const parsed = sketchUnderlaySchema.safeParse(value.underlay)
  return parsed.success ? { underlay: parsed.data } : undefined
}

/** The element's file id, the same on every canvas and on the server. */
export function underlayFileId(underlay: SketchUnderlay): string {
  return `underlay-${underlay.versionId}-p${underlay.page}-${underlay.dpi}`
}

/** Why an element may not stand as an underlay, or null when it may. */
export function underlayProblem(element: Record<string, unknown>): string | null {
  if (element.type !== 'image') return 'not an image'
  const data = keptUnderlayData(element.customData)
  if (!data) return 'an image that names no page'
  if (element.locked !== true) return 'an underlay that is not locked'
  if (element.fileId !== underlayFileId(data.underlay)) return 'an underlay whose file is not its page'
  if (element.crop !== undefined && element.crop !== null) return 'a cropped underlay'
  if (element.angle !== undefined && element.angle !== 0) return 'a turned underlay'
  const scale = element.scale
  if (scale !== undefined && !(Array.isArray(scale) && scale[0] === 1 && scale[1] === 1)) return 'a flipped underlay'
  if (element.link !== undefined && element.link !== null) return 'an underlay with a link'
  if (Object.keys(element.customData as object).length !== 1) return 'an underlay with other data'
  for (const side of ['width', 'height'] as const) {
    const value = element[side]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100_000) return 'an underlay without a size'
  }
  return null
}

export interface SceneUnderlay {
  elementId: string
  ref: SketchUnderlay
  /** Where the page lies on the sheet, in scene pixels. */
  box: { x: number; y: number; w: number; h: number }
}

/** The underlay a scene's drawn elements carry, or null. */
export function underlayOf(elements: readonly { readonly id: string; readonly type: string; readonly isDeleted?: boolean; readonly [field: string]: unknown }[]): SceneUnderlay | null {
  for (const element of elements) {
    if (element.isDeleted || element.type !== 'image') continue
    const data = keptUnderlayData(element.customData)
    if (!data) continue
    const n = (value: unknown) => (typeof value === 'number' ? Math.round(value) : 0)
    return { elementId: element.id, ref: data.underlay, box: { x: n(element.x), y: n(element.y), w: n(element.width), h: n(element.height) } }
  }
  return null
}

/** The page's facts an underlay element is sized from: one scene pixel per PDF point. */
export interface UnderlayPage {
  widthPt: number
  heightPt: number
}

/**
 * A new underlay element for a page, as Excalidraw's own image element is
 * shaped, at the origin. `index` is the lowest fractional index, so it sits
 * below everything drawn later.
 */
export function newUnderlayElement(id: string, underlay: SketchUnderlay, page: UnderlayPage, seed: number, at: { x: number; y: number } = { x: 0, y: 0 }) {
  return {
    id,
    type: 'image' as const,
    x: at.x,
    y: at.y,
    width: Math.max(1, Math.round(page.widthPt)),
    height: Math.max(1, Math.round(page.heightPt)),
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: true,
    status: 'saved',
    fileId: underlayFileId(underlay),
    scale: [1, 1],
    crop: null,
    customData: { underlay },
  }
}
