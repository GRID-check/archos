import { describe, expect, it } from 'vitest'
import {
  carriedViewpointValues,
  losesAnchor,
  markElementIds,
  presenceOf,
  viewpointElementIds,
  type CarriedViewpointSource,
} from './viewpoint-carry-plan'

const WALL = '2O2Fr$t4X7Zf8NOew3FLOH'
const DOOR = '3pGKgn9xH4$PdVA0l_Bk8z'
const SLAB = '1hOSvn6df7weDDVAKgmDHz'
const ROOF = '0RSwXnbbzCWw8lcMd1dR9z'

const source = (patch: Partial<CarriedViewpointSource> = {}): CarriedViewpointSource => ({
  id: 'vp-old',
  cameraKind: 'perspective',
  camera: {
    type: 'perspective',
    position: { x: 10, y: 20, z: 5 },
    direction: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    fieldOfView: 60,
    aspectRatio: 1.5,
  },
  clippingPlanes: [{ location: { x: 0, y: 0, z: 1.2 }, direction: { x: 0, y: 0, z: 1 } }],
  selectionIds: [WALL, DOOR],
  defaultVisibility: true,
  visibilityExceptionIds: [ROOF, SLAB],
  coloring: [
    { color: 'FF0000', globalIds: [WALL] },
    { color: '00FF00', globalIds: [ROOF] },
  ],
  pinPoint: { x: 1, y: 2, z: 3 },
  pinGlobalId: DOOR,
  ...patch,
})

describe('what a carried mark points at', () => {
  it('is its selection and its pinned element, each once; hidden and coloured ones are asked about but not counted', () => {
    expect(markElementIds(source())).toEqual([WALL, DOOR])
    expect(viewpointElementIds(source()).sort()).toEqual([WALL, DOOR, ROOF, SLAB].sort())
  })

  it('counts the elements the new Fassung still has, by GlobalId', () => {
    expect(presenceOf(source(), new Set([WALL, DOOR]))).toEqual({ present: 2, total: 2 })
    expect(presenceOf(source(), new Set([WALL]))).toEqual({ present: 1, total: 2 })
  })

  it('loses its anchor only when it pointed at elements and none is left', () => {
    expect(losesAnchor({ present: 0, total: 2 })).toBe(true)
    expect(losesAnchor({ present: 1, total: 2 })).toBe(false)
    // A view of the whole model never points at an element, so it never loses one.
    expect(losesAnchor({ present: 0, total: 0 })).toBe(false)
  })
})

describe('the new viewpoint a carry writes', () => {
  it('keeps the camera and the planes, filters every element list to what is there, drops the snapshot, and names the old one', () => {
    const next = carriedViewpointValues(source(), new Set([WALL, SLAB]), 'vp-new')
    expect(next).toMatchObject({
      id: 'vp-new',
      camera: source().camera,
      clippingPlanes: source().clippingPlanes,
      selectionIds: [WALL],
      visibilityExceptionIds: [SLAB],
      coloring: [{ color: 'FF0000', globalIds: [WALL] }],
      snapshotKey: null,
      snapshotBytes: null,
      snapshotContentType: null,
      carriedFromId: 'vp-old',
    })
  })

  it('drops a pin whose element is gone, and keeps one on its element or on a point of the view', () => {
    expect(carriedViewpointValues(source(), new Set([WALL]), 'n')).toMatchObject({ pinPoint: null, pinGlobalId: null })
    expect(carriedViewpointValues(source(), new Set([DOOR]), 'n')).toMatchObject({ pinPoint: { x: 1, y: 2, z: 3 }, pinGlobalId: DOOR })
    expect(carriedViewpointValues(source({ pinGlobalId: null }), new Set(), 'n')).toMatchObject({
      pinPoint: { x: 1, y: 2, z: 3 },
      pinGlobalId: null,
    })
  })
})
