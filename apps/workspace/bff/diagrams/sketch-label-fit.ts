/**
 * A box grown to hold its label, as the editor grows it (ADR-0149's open
 * item, closed for S4's edits).
 *
 * When the server lays a label out again (`sketch-render-worker.ts`,
 * `restoreElements` with `refreshDimensions`), Excalidraw wraps it to its
 * container's width but leaves the container as it was: growing it is
 * `redrawTextBoundingBox`, which only the editor calls. So a label an edit
 * made longer would spill out of its box in the filed picture. This is that
 * function's arithmetic, copied from Excalidraw 0.18.1
 * (`computeContainerDimensionForBoundText`, `getBoundTextMaxWidth`/`Height`,
 * `computeBoundTextPosition`): the box grows to the measured text (height
 * first, width only when one word is wider than the box), keeping its top
 * left as the editor does, and the label is placed in it again. Pure.
 */

import { BOUND_TEXT_PADDING } from './sketch-edit-elements'

interface Laid {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly textAlign?: unknown
  readonly verticalAlign?: unknown
}

interface Container {
  readonly id: string
  readonly type: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Excalidraw's `computeContainerDimensionForBoundText`. */
export function containerDimensionFor(dimension: number, type: string): number {
  const size = Math.ceil(dimension)
  const padding = BOUND_TEXT_PADDING * 2
  if (type === 'ellipse') return Math.round(((size + padding) / Math.sqrt(2)) * 2)
  if (type === 'diamond') return 2 * (size + padding)
  return size + padding
}

/** Excalidraw's `getBoundTextMaxWidth` / `getBoundTextMaxHeight` for a shape. */
export function labelRoomOf(type: string, dimension: number): number {
  if (type === 'ellipse') return Math.round((dimension / 2) * Math.sqrt(2)) - BOUND_TEXT_PADDING * 2
  if (type === 'diamond') return Math.round(dimension / 2) - BOUND_TEXT_PADDING * 2
  return dimension - BOUND_TEXT_PADDING * 2
}

/** Excalidraw's `getContainerCoords`: where the label's room starts inside the box. */
function roomOrigin(container: Container): { x: number; y: number } {
  let offsetX = BOUND_TEXT_PADDING
  let offsetY = BOUND_TEXT_PADDING
  if (container.type === 'ellipse') {
    offsetX += (container.width / 2) * (1 - Math.sqrt(2) / 2)
    offsetY += (container.height / 2) * (1 - Math.sqrt(2) / 2)
  }
  if (container.type === 'diamond') {
    offsetX += container.width / 4
    offsetY += container.height / 4
  }
  return { x: container.x + offsetX, y: container.y + offsetY }
}

/**
 * The container's new size when its laid-out label does not fit (`null` when
 * it fits), and where the label goes in it. Arrows and frames are left alone.
 */
export function fitContainerToLabel(
  container: Container,
  label: Laid
): { container: { id: string; x: number; y: number; width: number; height: number } | null; label: { x: number; y: number } } {
  const shape = container.type === 'rectangle' || container.type === 'ellipse' || container.type === 'diamond'
  if (!shape) return { container: null, label: { x: label.x, y: label.y } }
  let { width, height } = container
  if (label.height > labelRoomOf(container.type, height)) height = containerDimensionFor(label.height, container.type)
  if (label.width > labelRoomOf(container.type, width)) width = containerDimensionFor(label.width, container.type)
  const grown = { ...container, width, height }
  const origin = roomOrigin(grown)
  const roomWidth = labelRoomOf(grown.type, width)
  const roomHeight = labelRoomOf(grown.type, height)
  const y =
    label.verticalAlign === 'top'
      ? origin.y
      : label.verticalAlign === 'bottom'
        ? origin.y + roomHeight - label.height
        : origin.y + roomHeight / 2 - label.height / 2
  const x =
    label.textAlign === 'left' ? origin.x : label.textAlign === 'right' ? origin.x + roomWidth - label.width : origin.x + roomWidth / 2 - label.width / 2
  const changed = width !== container.width || height !== container.height
  return {
    container: changed ? { id: container.id, x: container.x, y: container.y, width, height } : null,
    label: { x, y },
  }
}
