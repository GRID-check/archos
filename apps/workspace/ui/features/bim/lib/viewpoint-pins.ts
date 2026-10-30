/**
 * Where a mark's pin stands on screen.
 *
 * A pin is a point of the model, drawn as a button over the canvas. Like the
 * measurement overlay (`measure-overlay.ts`) it is moved imperatively once per
 * frame from `Camera.projectToScreen`: sixty React renders a second to move a
 * few buttons would re-render the whole stage. React owns what a pin looks like
 * and does; this module owns only where it is.
 *
 * Occlusion is not tested: a pin behind a wall still shows, as a dimension line
 * does. It marks a place, it does not claim the place is visible.
 */

import { renderPoint, type Vec3 } from './viewpoint'
import type { ViewerPin } from './viewpoint-bridge'
import type { RenderFrameInfo } from '@ifc-lite/geometry/world-frame'

/** World point (render frame) to canvas CSS pixels, or null when behind the camera. */
export type PinProjector = (point: Vec3) => { x: number; y: number } | null

interface Box {
  min: Vec3
  max: Vec3
}

/** The centre of the union of these boxes, or null for none: where a pin stands on a set of elements. */
export function unionCentre(boxes: readonly Box[]): Vec3 | null {
  if (boxes.length === 0) return null
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const box of boxes) {
    min.x = Math.min(min.x, box.min.x)
    min.y = Math.min(min.y, box.min.y)
    min.z = Math.min(min.z, box.min.z)
    max.x = Math.max(max.x, box.max.x)
    max.y = Math.max(max.y, box.max.y)
    max.z = Math.max(max.z, box.max.z)
  }
  return { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }
}

/**
 * Each pin's point in the render frame: its stored world point, else the centre
 * of its elements (`boxOf`, by GlobalId). A pin with neither is left out.
 */
export function pinPoints(
  pins: readonly ViewerPin[],
  frame: RenderFrameInfo | null,
  boxOf: (globalId: string) => Box | null
): Map<string, Vec3> {
  const out = new Map<string, Vec3>()
  for (const pin of pins) {
    if (pin.world) {
      out.set(pin.id, renderPoint(pin.world, frame))
      continue
    }
    const boxes = pin.globalIds.map(boxOf).filter((box): box is Box => box !== null)
    const centre = unionCentre(boxes)
    if (centre) out.set(pin.id, centre)
  }
  return out
}

const round = (value: number): number => Math.round(value * 10) / 10

/**
 * Move every `[data-pin-id]` child of `layer` to its point. A pin that has no
 * point, is behind the camera or lies outside the canvas is hidden, not
 * clamped to an edge: a pin at the screen's rim would point at nothing.
 */
export function placePins(
  layer: HTMLElement,
  points: ReadonlyMap<string, Vec3>,
  project: PinProjector,
  size: { width: number; height: number }
): void {
  for (const node of Array.from(layer.children)) {
    if (!(node instanceof HTMLElement)) continue
    const point = node.dataset.pinId ? points.get(node.dataset.pinId) : undefined
    const screen = point ? project(point) : null
    const inside =
      screen !== null && screen.x >= 0 && screen.y >= 0 && screen.x <= size.width && screen.y <= size.height
    if (!screen || !inside) {
      node.style.visibility = 'hidden'
      continue
    }
    node.style.visibility = 'visible'
    node.style.transform = `translate(${round(screen.x)}px, ${round(screen.y)}px)`
  }
}

/**
 * Per canvas, who wants to know about each drawn frame. The controller calls
 * {@link notifyFrame} from the frame it already draws (one line); the pin layer
 * registers here, so no ref crosses the controller's boundary.
 */
const frameListeners = new WeakMap<object, (project: PinProjector, size: { width: number; height: number }) => void>()

export function onFrameOf(
  canvas: object,
  listener: (project: PinProjector, size: { width: number; height: number }) => void
): () => void {
  frameListeners.set(canvas, listener)
  return () => {
    if (frameListeners.get(canvas) === listener) frameListeners.delete(canvas)
  }
}

export function notifyFrame(canvas: object, project: PinProjector, size: { width: number; height: number }): void {
  frameListeners.get(canvas)?.(project, size)
}
