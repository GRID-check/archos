/**
 * A Skizze read as structure: what a person or a model needs to answer "what
 * does this sketch say" without looking at it (ADR-0148).
 *
 * Derived from the stored scene alone, with no model call: Excalidraw already
 * records which text labels which shape (`containerId`), which shapes an arrow
 * joins (`startBinding`, `endBinding`) and which elements a frame holds
 * (`frameId`). The outline names things by their LABEL, because "Küche → Essen"
 * is what a reader means, and keeps each id beside it, because a later write
 * (`document-sketch-update`) addresses elements by id.
 *
 * Deleted elements are left out: Excalidraw keeps them in the scene for undo
 * and for merging, and nobody drew them.
 *
 * Geometry too, rounded to whole scene pixels, because an agent placing a new
 * element has to know where the others are without looking at the picture: a
 * `box` on every shape, frame, free text and connection, and the `points` of a
 * line that is not bound at both ends (a plot boundary, a street, a section
 * floor), which nothing else locates. Coordinates are Excalidraw's scene
 * coordinates, y downwards; a sketch claims no dimension, so they are positions
 * on the sheet, never measurements.
 */

import type { SceneElement, SketchScene } from './sketch-scene'

const SHAPE_TYPES: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'diamond'])
const CONNECTOR_TYPES: ReadonlySet<string> = new Set(['arrow', 'line'])

/** At most this many points of one unbound line; a longer one keeps its first and last and an even sample between. */
export const MAX_OUTLINE_POINTS = 24

/** An element's place on the sheet, in whole scene pixels: top left, width, height. */
export interface SketchBox {
  x: number
  y: number
  w: number
  h: number
}

export interface SketchOutlineText {
  id: string
  text: string
  /** The shape, arrow or frame this text labels; `null` for free text on the canvas. */
  container: { id: string; type: string } | null
  /** Free text only: a label sits in its container's box. */
  box?: SketchBox
}

export interface SketchOutlineShape {
  id: string
  type: string
  /** Its label's text, or `null` for an unlabelled shape. */
  label: string | null
  box: SketchBox
}

export interface SketchOutlineConnection {
  id: string
  type: string
  from: { id: string; label: string | null } | null
  to: { id: string; label: string | null } | null
  /** The text on the arrow itself. */
  label: string | null
  box: SketchBox
  /** The line's points in scene coordinates, when an end is not bound to a shape. */
  points?: [number, number][]
}

export interface SketchOutlineFrame {
  id: string
  name: string | null
  box: SketchBox
  /** The elements inside it, by label where they have one. */
  children: { id: string; type: string; label: string | null }[]
}

export interface SketchOutline {
  texts: SketchOutlineText[]
  shapes: SketchOutlineShape[]
  connections: SketchOutlineConnection[]
  frames: SketchOutlineFrame[]
}

function clean(text: string | undefined): string | null {
  const value = text?.replace(/\s+/g, ' ').trim()
  return value ? value : null
}

/** Each element's label: its own text for a text element, its bound text's for a container. */
function labelsOf(elements: readonly SceneElement[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const element of elements) {
    if (element.type !== 'text') continue
    const text = clean(element.text)
    if (!text) continue
    labels.set(element.id, text)
    if (element.containerId) labels.set(element.containerId, text)
  }
  return labels
}

function endpoint(
  binding: { elementId: string } | null | undefined,
  labels: Map<string, string>,
): { id: string; label: string | null } | null {
  if (!binding?.elementId) return null
  return { id: binding.elementId, label: labels.get(binding.elementId) ?? null }
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** The absolute points of a line or arrow (Excalidraw stores them relative to `x`, `y`). */
function pointsOf(element: SceneElement): [number, number][] {
  const raw = Array.isArray(element.points) ? (element.points as unknown[]) : []
  return raw.flatMap((point) =>
    Array.isArray(point) && point.length >= 2 ? [[Math.round(element.x + num(point[0])), Math.round(element.y + num(point[1]))] as [number, number]] : []
  )
}

/** A shape's box from its own size, a line's from its points. Width and height may be negative on a flipped shape. */
function boxOf(element: SceneElement): SketchBox {
  if (CONNECTOR_TYPES.has(element.type)) {
    const points = pointsOf(element)
    if (points.length > 0) {
      const xs = points.map(([x]) => x)
      const ys = points.map(([, y]) => y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
  }
  const width = num(element.width)
  const height = num(element.height)
  const x = Math.round(Math.min(element.x, element.x + width))
  const y = Math.round(Math.min(element.y, element.y + height))
  return { x, y, w: Math.round(Math.abs(width)), h: Math.round(Math.abs(height)) }
}

/** At most {@link MAX_OUTLINE_POINTS}, the ends always kept. */
function sampled(points: [number, number][]): [number, number][] {
  if (points.length <= MAX_OUTLINE_POINTS) return points
  const step = (points.length - 1) / (MAX_OUTLINE_POINTS - 1)
  return Array.from({ length: MAX_OUTLINE_POINTS }, (_, index) => points[Math.round(index * step)])
}

/** The outline of a scene. Pure; its size follows the scene's, which `sketch-scene.ts` bounds. */
export function outlineSketch(scene: SketchScene): SketchOutline {
  const elements = scene.elements.filter((element) => !element.isDeleted)
  const byId = new Map(elements.map((element) => [element.id, element]))
  const labels = labelsOf(elements)
  const outline: SketchOutline = { texts: [], shapes: [], connections: [], frames: [] }

  for (const element of elements) {
    if (element.type === 'text') {
      const text = clean(element.text)
      if (!text) continue
      const container = element.containerId ? byId.get(element.containerId) : undefined
      outline.texts.push(
        container
          ? { id: element.id, text, container: { id: container.id, type: container.type } }
          : { id: element.id, text, container: null, box: boxOf(element) }
      )
    } else if (SHAPE_TYPES.has(element.type)) {
      outline.shapes.push({ id: element.id, type: element.type, label: labels.get(element.id) ?? null, box: boxOf(element) })
    } else if (CONNECTOR_TYPES.has(element.type)) {
      const from = endpoint(element.startBinding, labels)
      const to = endpoint(element.endBinding, labels)
      outline.connections.push({
        id: element.id,
        type: element.type,
        from,
        to,
        label: labels.get(element.id) ?? null,
        box: boxOf(element),
        ...(from && to ? {} : { points: sampled(pointsOf(element)) }),
      })
    } else if (element.type === 'frame') {
      outline.frames.push({ id: element.id, name: clean(element.name ?? undefined), box: boxOf(element), children: [] })
    }
  }

  const frames = new Map(outline.frames.map((frame) => [frame.id, frame]))
  for (const element of elements) {
    const frame = element.frameId ? frames.get(element.frameId) : undefined
    // A container's label is listed once, with its container.
    if (!frame || (element.type === 'text' && element.containerId)) continue
    frame.children.push({ id: element.id, type: element.type, label: labels.get(element.id) ?? null })
  }
  return outline
}
