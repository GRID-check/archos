/**
 * Where elements of a Skizze sit on its exported sheet: the box of a mark
 * pinned to them (migration 0192, `docs/architecture/document-annotations.md`,
 * „A mark on a Skizze").
 *
 * The sheet is the SVG the editor exported (`sketch-canvas.tsx`, `prepare`):
 * Excalidraw's `exportToSvg` draws the scene's common bounds plus a padding on
 * every side, at scale 1, into a `viewBox` of `0 0 width height`. So a point of
 * the scene maps onto the sheet by one translation, and the padding is read off
 * the stored `viewBox` rather than assumed: whatever Excalidraw's bounds add
 * that ours leave out, it adds to both sides alike.
 *
 * An element's bounds are its corners turned about its centre by its `angle`;
 * a line, an arrow or a freehand stroke by its points, turned the same way.
 * Excalidraw's own bounds follow a curve's bulge too; a mark only needs to sit
 * on its elements, not trace them.
 *
 * Pure: the server derives the box with it (`./sketch-place.ts`,
 * `./sketch-carry.ts`), and the editor draws the pins over the live canvas with
 * the same arithmetic (`features/diagrams/sketch/sketch-pins.tsx`).
 */

/** The fields of an Excalidraw element the bounds read. Every other field is ignored. */
export interface AnchorElement {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width?: unknown
  readonly height?: unknown
  readonly angle?: unknown
  readonly points?: unknown
  readonly isDeleted?: boolean
}

/** A box in scene units: left, top, right, bottom. */
export type SceneBox = readonly [number, number, number, number]

/** The exported sheet in scene units: its top-left corner and its size. */
export interface SheetFrame {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** A box on the sheet, in shares of it, top-left origin: the frame every mark is stored in. */
export interface SheetRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The padding the editor exports with (`sketch-canvas.tsx`); the server reads it off the `viewBox` instead. */
export const SKETCH_EXPORT_PADDING = 16

/** The smallest side a region keeps, as a share of the sheet: a horizontal line still makes a box. */
const MIN_SIDE = 0.002

const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

function pointsOf(element: AnchorElement): Array<readonly [number, number]> | null {
  if (!Array.isArray(element.points) || element.points.length === 0) return null
  const points: Array<readonly [number, number]> = []
  for (const point of element.points) {
    if (Array.isArray(point) && point.length >= 2) points.push([finite(point[0]), finite(point[1])])
  }
  return points.length > 0 ? points : null
}

const boxAround = (points: ReadonlyArray<readonly [number, number]>): SceneBox => [
  Math.min(...points.map(([x]) => x)),
  Math.min(...points.map(([, y]) => y)),
  Math.max(...points.map(([x]) => x)),
  Math.max(...points.map(([, y]) => y)),
]

/** One element's bounds in scene units, turned by its angle; null for a deleted element. */
export function elementBounds(element: AnchorElement): SceneBox | null {
  if (element.isDeleted) return null
  const own = pointsOf(element)
  const local: Array<readonly [number, number]> = own
    ? own.map(([px, py]) => [element.x + px, element.y + py])
    : (() => {
        const width = finite(element.width)
        const height = finite(element.height)
        return [
          [element.x, element.y],
          [element.x + width, element.y],
          [element.x + width, element.y + height],
          [element.x, element.y + height],
        ]
      })()
  const angle = finite(element.angle)
  if (angle === 0) return boxAround(local)
  const [left, top, right, bottom] = boxAround(local)
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return boxAround(local.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]))
}

/** The union of the bounds of these elements; null when none of them is drawn. */
export function unionBounds(elements: readonly AnchorElement[]): SceneBox | null {
  const boxes = elements.map(elementBounds).filter((box): box is SceneBox => box !== null)
  if (boxes.length === 0) return null
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ]
}

/** The sheet of a scene exported with `padding` on every side, as the editor exports it. */
export function paddedFrame(elements: readonly AnchorElement[], padding = SKETCH_EXPORT_PADDING): SheetFrame | null {
  const bounds = unionBounds(elements)
  if (!bounds) return null
  return {
    left: bounds[0] - padding,
    top: bounds[1] - padding,
    width: bounds[2] - bounds[0] + 2 * padding,
    height: bounds[3] - bounds[1] + 2 * padding,
  }
}

/** The sheet a stored SVG of this scene is: the `viewBox`'s size, the padding what it adds to the bounds. */
export function sheetFrame(elements: readonly AnchorElement[], viewBox: { width: number; height: number }): SheetFrame | null {
  const bounds = unionBounds(elements)
  if (!bounds || !(viewBox.width > 0) || !(viewBox.height > 0)) return null
  return {
    left: bounds[0] - (viewBox.width - (bounds[2] - bounds[0])) / 2,
    top: bounds[1] - (viewBox.height - (bounds[3] - bounds[1])) / 2,
    width: viewBox.width,
    height: viewBox.height,
  }
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000

/** A box of the scene as a region of the sheet: clamped onto it, never thinner than {@link MIN_SIDE}. */
export function regionOnSheet(box: SceneBox, frame: SheetFrame): SheetRegion {
  const x0 = clamp((box[0] - frame.left) / frame.width)
  const y0 = clamp((box[1] - frame.top) / frame.height)
  const w = Math.max(clamp((box[2] - frame.left) / frame.width) - x0, MIN_SIDE)
  const h = Math.max(clamp((box[3] - frame.top) / frame.height) - y0, MIN_SIDE)
  const x = Math.min(x0, 1 - w)
  const y = Math.min(y0, 1 - h)
  return { x: round(x), y: round(y), w: round(w), h: round(h) }
}

/** The region of the elements named by `ids` on this sheet; null when none of them is in the scene. */
export function regionInFrame(elements: readonly AnchorElement[], ids: readonly string[], frame: SheetFrame): SheetRegion | null {
  const wanted = new Set(ids)
  const box = unionBounds(elements.filter((element) => wanted.has(element.id)))
  return box ? regionOnSheet(box, frame) : null
}

/**
 * The box of a mark pinned to `ids`, on the sheet a stored SVG with this
 * `viewBox` draws of the scene; null when none of the elements is in it.
 */
export function elementRegion(
  scene: { readonly elements: readonly AnchorElement[] },
  ids: readonly string[],
  viewBox: { width: number; height: number }
): SheetRegion | null {
  const frame = sheetFrame(scene.elements, viewBox)
  return frame ? regionInFrame(scene.elements, ids, frame) : null
}

/** The ids among `ids` that the scene draws (not deleted), in the order given. */
export function presentIds(elements: readonly AnchorElement[], ids: readonly string[]): string[] {
  const drawn = new Set(elements.filter((element) => !element.isDeleted).map((element) => element.id))
  return ids.filter((id) => drawn.has(id))
}

/** The `viewBox` size of a stored SVG's root, read without parsing the drawing; null when it has none. */
export function viewBoxOf(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0]
  const value = root ? /\bviewBox\s*=\s*["']([^"']+)["']/.exec(root)?.[1] : undefined
  const parts = value?.trim().split(/[\s,]+/).map(Number)
  if (!parts || parts.length !== 4 || !parts.every(Number.isFinite)) return null
  return parts[2] > 0 && parts[3] > 0 ? { width: parts[2], height: parts[3] } : null
}
