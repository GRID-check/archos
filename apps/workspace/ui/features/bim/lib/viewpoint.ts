/**
 * A model view as data, and back: the viewer half of a mark on a model.
 *
 * `captureViewpoint` reads what the viewport shows (camera, cut, visibility,
 * selection) into a BCF-shaped value; `restoreViewpoint` puts such a value
 * back. Pure: the renderer arrives as a structural stub, so the maths is
 * testable without WebGL.
 *
 * ## Frames (these matter for BCF export)
 *
 * The renderer works in the "render frame": Y-up, shifted by the RTC offset
 * and the origin shift. The wire is IFC world, Z-up, metres. A POINT goes
 * `viewerToIfcAxes` then `+ renderFrameWorldOffset(frame)`; a DIRECTION only
 * rotates. Both helpers come from `@ifc-lite/geometry/world-frame` and are not
 * copied (`scripts/check-rtc-frame-copies.mjs`). `originShift` is Y-up and
 * `wasmRtcOffset` Z-up: `renderFrameWorldOffset` already accounts for that.
 *
 * ## Conventions pinned here
 *
 * - Orthographic: `Camera.getOrthoSize()` is the HALF visible height. The wire
 *   `viewToWorldScale` is the FULL visible height in metres (the That Open /
 *   BCF viewer convention, `top - bottom`), so it is `2 * getOrthoSize()`.
 * - Section: the renderer discards fragments with `dot(p, n) - d > 0`
 *   (`n = +Y`, flipped negates). Unflipped therefore hides everything ABOVE
 *   the cut, so the BCF direction (toward the hidden half) is +Z; flipped is -Z.
 * - Aspect is captured but never restored: the viewport on the other end has
 *   its own.
 */

import type { RenderFrameInfo } from '@ifc-lite/geometry/world-frame'
import {
  renderFrameWorldOffset,
  viewerToIfcAxes,
  ifcToViewerAxes,
} from '@ifc-lite/geometry/world-frame'
import type {
  ClippingPlane,
  Vec3,
  ViewpointCamera,
  ViewpointComponents,
  ViewpointInput,
} from '@/lib/annotations/viewpoint-types'
import type { BimViewerElement, ViewerVisibility } from './model-index'
import type { BimSection } from './viewer-camera'

export type { Vec3, ViewpointCamera, ViewpointInput }

/** What {@link captureViewpoint} returns: the wire input, minus the pin and snapshot the caller adds. */
export type CapturedViewpoint = Omit<ViewpointInput, 'pin' | 'snapshot'> & {
  clippingPlanes: ClippingPlane[]
  components: ViewpointComponents
  /**
   * Whether the viewer held more than the wire takes (500 selected, 2000
   * visibility exceptions) and the lists were cut. The caller must say so and
   * must leave this field out of the request (the wire is strict). A cut
   * exception list of an isolation shows only part of what was isolated, not
   * the picture the person saw: there is no cheaper way to say it than the
   * set itself, so the caller warns instead of storing it silently.
   */
  truncated: { selection: boolean; exceptions: boolean }
}

export const MAX_SELECTION = 500
export const MAX_EXCEPTIONS = 2000

/** The renderer camera as a state snapshot; units are render frame, radians. */
export interface CameraSnapshot {
  position: Vec3
  target: Vec3
  up: Vec3
  fovRadians: number
  projection: 'perspective' | 'orthographic'
  /** `Camera.getOrthoSize()`: half the visible height. */
  orthoHalfHeight: number
  aspect: number
}

export interface RenderBounds {
  min: Vec3
  max: Vec3
}

export interface CaptureState {
  camera: CameraSnapshot
  section: BimSection | null
  /** Render-frame model bounds; centres the section plane's location. */
  bounds: RenderBounds | null
  visibility: ViewerVisibility
  selected: ReadonlySet<number>
  frame: RenderFrameInfo | null
  elementsByExpressId: ReadonlyMap<number, Pick<BimViewerElement, 'globalId'>>
}

/** What restore needs from the renderer's camera (a subset of `Camera`). */
export interface ViewpointCameraTarget {
  setPosition(x: number, y: number, z: number): void
  setTarget(x: number, y: number, z: number): void
  setUp(x: number, y: number, z: number): void
  setFOV(fov: number): void
  setProjectionMode(mode: 'perspective' | 'orthographic'): void
  setOrthoSize(size: number): void
  getDistance(): number
}

export interface RestoreContext {
  frame: RenderFrameInfo | null
  expressIdByGlobalId: ReadonlyMap<string, number>
}

export interface RestoredViewpoint {
  /** GlobalIds (selection, exceptions) that matched nothing in this model. */
  missing: number
  section: BimSection | null
  visibility: ViewerVisibility
  selected: ReadonlySet<number>
  /** Planes that were not a horizontal cut and so were not applied. */
  ignoredPlanes: number
}

const clean = (n: number): number => n + 0 // -0 -> 0
const cleanVec = (v: Vec3): Vec3 => ({ x: clean(v.x), y: clean(v.y), z: clean(v.z) })

function normalize(v: Vec3, fallback: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z)
  if (!Number.isFinite(length) || length === 0) return fallback
  return cleanVec({ x: v.x / length, y: v.y / length, z: v.z / length })
}

/** A render-frame point as IFC world coordinates (Z-up, metres): what a viewpoint stores. */
export function worldPoint(point: Vec3, frame: RenderFrameInfo | null): Vec3 {
  const local = viewerToIfcAxes(point)
  const offset = renderFrameWorldOffset(frame)
  return cleanVec({ x: local.x + offset.x, y: local.y + offset.y, z: local.z + offset.z })
}

/** An IFC world point back in the render frame: where a stored pin stands in this viewer. */
export function renderPoint(point: Vec3, frame: RenderFrameInfo | null): Vec3 {
  const offset = renderFrameWorldOffset(frame)
  return cleanVec(
    ifcToViewerAxes({ x: point.x - offset.x, y: point.y - offset.y, z: point.z - offset.z })
  )
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

function globalIdsOf(
  expressIds: Iterable<number>,
  index: CaptureState['elementsByExpressId']
): string[] {
  const out = new Set<string>()
  for (const id of expressIds) {
    const element = index.get(id)
    if (element) out.add(element.globalId)
  }
  return [...out]
}

function captureCamera(state: CaptureState): ViewpointCamera {
  const { camera, frame } = state
  const position = worldPoint(camera.position, frame)
  const target = worldPoint(camera.target, frame)
  const direction = normalize(
    { x: target.x - position.x, y: target.y - position.y, z: target.z - position.z },
    // Degenerate pose: render -Z (the renderer's default forward) in IFC axes.
    { x: 0, y: 1, z: 0 }
  )
  const up = normalize(viewerToIfcAxes(camera.up), { x: 0, y: 0, z: 1 })
  const aspectRatio = clamp(Number.isFinite(camera.aspect) ? camera.aspect : 1, 0.1, 10)
  if (camera.projection === 'orthographic') {
    return {
      type: 'orthographic',
      position,
      direction,
      up,
      viewToWorldScale: 2 * camera.orthoHalfHeight,
      aspectRatio,
    }
  }
  return {
    type: 'perspective',
    position,
    direction,
    up,
    fieldOfView: clamp((camera.fovRadians * 180) / Math.PI, 1, 179),
    aspectRatio,
  }
}

function captureSection(state: CaptureState): ClippingPlane[] {
  const { section, bounds, frame } = state
  if (!section) return []
  const center = bounds
    ? {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: 0,
        z: (bounds.min.z + bounds.max.z) / 2,
      }
    : { x: 0, y: 0, z: 0 }
  // x/z (render) are a point on the plane; the height is the cut itself.
  const onPlane = worldPoint(center, frame)
  const zOffset = renderFrameWorldOffset(frame).z
  return [
    {
      location: cleanVec({ x: onPlane.x, y: onPlane.y, z: section.atMetres + zOffset }),
      direction: { x: 0, y: 0, z: section.flipped ? -1 : 1 },
    },
  ]
}

export function captureViewpoint(state: CaptureState): CapturedViewpoint {
  const { visibility, elementsByExpressId } = state
  const isolated = visibility.isolated
  // Isolation wins; hidden elements inside it are removed from the set.
  const exceptionIds = isolated
    ? [...isolated].filter((id) => !visibility.hidden.has(id))
    : [...visibility.hidden]
  const selection = globalIdsOf(state.selected, elementsByExpressId)
  const exceptions = globalIdsOf(exceptionIds, elementsByExpressId)
  return {
    camera: captureCamera(state),
    clippingPlanes: captureSection(state),
    components: {
      selection: { globalIds: selection.slice(0, MAX_SELECTION) },
      visibility: { defaultVisibility: isolated === null, exceptions: exceptions.slice(0, MAX_EXCEPTIONS) },
      coloring: [],
    },
    truncated: { selection: selection.length > MAX_SELECTION, exceptions: exceptions.length > MAX_EXCEPTIONS },
  }
}

const HORIZONTAL = 0.999

export function restoreViewpoint(
  viewpoint: ViewpointInput,
  camera: ViewpointCameraTarget,
  context: RestoreContext
): RestoredViewpoint {
  const { frame, expressIdByGlobalId } = context
  const vp = viewpoint.camera
  const distance = camera.getDistance()
  const reach = Number.isFinite(distance) && distance > 0 ? distance : 10

  camera.setProjectionMode(vp.type)
  const position = renderPoint(vp.position, frame)
  const forward = ifcToViewerAxes(normalize(vp.direction, { x: 0, y: 1, z: 0 }))
  const up = ifcToViewerAxes(normalize(vp.up, { x: 0, y: 0, z: 1 }))
  camera.setPosition(position.x, position.y, position.z)
  camera.setTarget(
    clean(position.x + forward.x * reach),
    clean(position.y + forward.y * reach),
    clean(position.z + forward.z * reach)
  )
  camera.setUp(up.x, up.y, up.z)
  if (vp.type === 'perspective') camera.setFOV((vp.fieldOfView * Math.PI) / 180)
  else camera.setOrthoSize(vp.viewToWorldScale / 2)

  const unresolved = new Set<string>()
  const resolve = (globalIds: readonly string[]): Set<number> => {
    const out = new Set<number>()
    for (const globalId of globalIds) {
      const id = expressIdByGlobalId.get(globalId)
      if (id === undefined) unresolved.add(globalId)
      else out.add(id)
    }
    return out
  }
  const { selection, visibility } = viewpoint.components
  const selected = resolve(selection.globalIds)
  const exceptions = resolve(visibility.exceptions)

  const zOffset = renderFrameWorldOffset(frame).z
  let section: BimSection | null = null
  let ignoredPlanes = 0
  for (const plane of viewpoint.clippingPlanes ?? []) {
    const d = normalize(plane.direction, { x: 0, y: 0, z: 0 })
    if (section === null && Math.abs(d.z) > HORIZONTAL) {
      section = { atMetres: clean(plane.location.z - zOffset), flipped: d.z < 0 }
    } else ignoredPlanes += 1
  }

  return {
    missing: unresolved.size,
    section,
    // An isolation of which this model has none of the elements would be an empty view: show everything instead.
    visibility:
      visibility.defaultVisibility || exceptions.size === 0
        ? { hidden: visibility.defaultVisibility ? exceptions : new Set(), isolated: null }
        : { hidden: new Set(), isolated: exceptions },
    selected,
    ignoredPlanes,
  }
}
