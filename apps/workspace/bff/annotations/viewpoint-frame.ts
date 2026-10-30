/**
 * Frames a viewpoint on stored element boxes: the pure, deterministic core of
 * a model mark Piloti proposes. Geometry comes only from the boxes (IFC world
 * coordinates, Z-up, metres, as the element table or an ingest step stores
 * them) and the fixed constants below. A model never writes a coordinate.
 */

import {
  MAX_CLIPPING_PLANES,
  MAX_VIEWPOINT_SELECTION,
  viewpointInputSchema,
  type ClippingPlane,
  type Vec3,
  type ViewpointInput,
} from './viewpoint-types'

/** An element's world-space axis-aligned bounding box. */
export type Box3 = { globalId: string; min: Vec3; max: Vec3 }

/** Where the camera stands, clockwise from north (+Y): south-west, looking north-east. */
export const VIEW_AZIMUTH_DEG = 225
/** How far above the horizon the camera looks down. */
export const VIEW_ELEVATION_DEG = 30
/** Vertical field of view, degrees (BCF's `FieldOfView`). */
export const VIEW_FIELD_OF_VIEW_DEG = 60
/** Width over height of the frame the box is fitted into. */
export const VIEW_ASPECT_RATIO = 16 / 9
/** The bounding sphere is pushed this much further out than a tight fit. */
export const VIEW_MARGIN = 1.15
/** Metres a section box stands off the targets' union. */
export const SECTION_PADDING_M = 0.5
/** A union whose bounding sphere is smaller than this is a point, not an element (metres). */
export const MIN_RADIUS_M = 1e-3
/** Beyond this bounding-sphere radius (metres) the box is not one building's element: a unit or a coordinate error. */
export const MAX_RADIUS_M = 1e5

export type FrameViewpointOptions = {
  /** Add a section box (up to six planes) around the targets. Default false. */
  section?: boolean
  /** Metres of padding for the section box. Default {@link SECTION_PADDING_M}. */
  sectionPadding?: number
  /** Default {@link VIEW_MARGIN}; at least 1. */
  margin?: number
  /** Default {@link VIEW_ASPECT_RATIO}. */
  aspectRatio?: number
  /** Default {@link VIEW_FIELD_OF_VIEW_DEG}. */
  fieldOfView?: number
}

export type FrameErrorCode = 'empty' | 'not_finite' | 'inverted' | 'degenerate' | 'too_large' | 'too_many'

/** Why a box list cannot be framed; `code` is what a caller acts on. */
export class ViewpointFrameError extends Error {
  readonly code: FrameErrorCode
  constructor(code: FrameErrorCode, message: string) {
    super(message)
    this.name = 'ViewpointFrameError'
    this.code = code
  }
}

const AXES = ['x', 'y', 'z'] as const
const COORDINATE_LIMIT = 1e7
const RAD = Math.PI / 180

const isFiniteVec = (v: Vec3) => AXES.every((a) => Number.isFinite(v[a]))

function unionOf(boxes: readonly Box3[]): { min: Vec3; max: Vec3 } {
  if (boxes.length === 0) throw new ViewpointFrameError('empty', 'no boxes to frame')
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const box of boxes) {
    if (!isFiniteVec(box.min) || !isFiniteVec(box.max))
      throw new ViewpointFrameError('not_finite', `box ${box.globalId} has a non-finite coordinate`)
    for (const a of AXES) {
      if (box.min[a] > box.max[a])
        throw new ViewpointFrameError('inverted', `box ${box.globalId} has min above max on ${a}`)
      min[a] = Math.min(min[a], box.min[a])
      max[a] = Math.max(max[a], box.max[a])
    }
  }
  return { min, max }
}

function sectionPlanes(min: Vec3, max: Vec3, centre: Vec3, pad: number): ClippingPlane[] {
  const planes: ClippingPlane[] = []
  for (const a of AXES) {
    for (const sign of [1, -1] as const) {
      const face = sign === 1 ? max[a] + pad : min[a] - pad
      const direction = { x: 0, y: 0, z: 0, [a]: sign }
      planes.push({ location: { ...centre, [a]: face }, direction })
    }
  }
  return planes.slice(0, MAX_CLIPPING_PLANES)
}

/**
 * The camera, selection and optional section box that show `boxes` whole. The
 * camera looks at the union's centre from a fixed azimuth and elevation, at a
 * distance where the bounding sphere (radius r) fits the narrower half of the
 * field of view: `distance = margin * r / sin(min(vHalf, hHalf))`. Up is Z.
 */
export function frameViewpoint(boxes: readonly Box3[], opts: FrameViewpointOptions = {}): ViewpointInput {
  const { min, max } = unionOf(boxes)
  const margin = opts.margin ?? VIEW_MARGIN
  const aspectRatio = opts.aspectRatio ?? VIEW_ASPECT_RATIO
  const fieldOfView = opts.fieldOfView ?? VIEW_FIELD_OF_VIEW_DEG
  const pad = opts.sectionPadding ?? SECTION_PADDING_M
  if (!(margin >= 1) || !(pad >= 0)) throw new RangeError('margin must be at least 1 and padding not negative')

  const globalIds = [...new Set(boxes.map((b) => b.globalId))]
  if (globalIds.length > MAX_VIEWPOINT_SELECTION)
    throw new ViewpointFrameError('too_many', `${globalIds.length} elements exceed ${MAX_VIEWPOINT_SELECTION}`)

  const centre = {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  }
  const radius = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2
  if (!(radius >= MIN_RADIUS_M)) throw new ViewpointFrameError('degenerate', 'the boxes are a point')
  if (radius > MAX_RADIUS_M) throw new ViewpointFrameError('too_large', `bounding radius ${radius} m is too large`)

  const vHalf = (fieldOfView * RAD) / 2
  const hHalf = Math.atan(Math.tan(vHalf) * aspectRatio)
  const distance = (margin * radius) / Math.sin(Math.min(vHalf, hHalf))

  const az = VIEW_AZIMUTH_DEG * RAD
  const el = VIEW_ELEVATION_DEG * RAD
  const toCamera = { x: Math.sin(az) * Math.cos(el), y: Math.cos(az) * Math.cos(el), z: Math.sin(el) }
  const position = {
    x: centre.x + toCamera.x * distance,
    y: centre.y + toCamera.y * distance,
    z: centre.z + toCamera.z * distance,
  }
  const planeReach = Math.max(...AXES.map((a) => Math.max(Math.abs(min[a]), Math.abs(max[a])))) + pad
  if (AXES.some((a) => Math.abs(position[a]) > COORDINATE_LIMIT) || planeReach > COORDINATE_LIMIT)
    throw new ViewpointFrameError('too_large', 'the framed view leaves the coordinate range')

  const input: ViewpointInput = {
    camera: {
      type: 'perspective',
      position,
      direction: { x: -toCamera.x, y: -toCamera.y, z: -toCamera.z },
      up: { x: 0, y: 0, z: 1 },
      aspectRatio,
      fieldOfView,
    },
    clippingPlanes: opts.section ? sectionPlanes(min, max, centre, pad) : [],
    components: {
      selection: { globalIds },
      visibility: { defaultVisibility: true, exceptions: [] },
      coloring: [],
    },
  }
  return viewpointInputSchema.parse(input)
}
