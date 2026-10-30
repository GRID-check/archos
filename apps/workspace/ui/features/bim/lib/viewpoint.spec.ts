/**
 * Viewpoint capture and restore against a stub camera.
 *
 * The literals are hand-computed AND were checked against the real
 * `@ifc-lite/geometry/world-frame` helpers: a render point (x, y, z) is
 * Z-up (x, -z, y) before the offset is added; `originShift` is Y-up (it is
 * negated on z like any render-frame vector), `wasmRtcOffset` is Z-up.
 */

import { describe, expect, it } from 'vitest'
import {
  captureViewpoint,
  restoreViewpoint,
  type CameraSnapshot,
  type CaptureState,
  type ViewpointCameraTarget,
} from './viewpoint'
import { NOTHING_HIDDEN } from './model-index'

const RTC = { wasmRtcOffset: { x: 2683000, y: 1245000, z: 0 } }
const SHIFTED = {
  originShift: { x: 100, y: 7, z: -30 },
  wasmRtcOffset: { x: 2683000, y: 1245000, z: 50 },
}

const ELEMENTS = [
  { globalId: '0AAAAAAAAAAAAAAAAAAAA1', expressId: 11 },
  { globalId: '0AAAAAAAAAAAAAAAAAAAA2', expressId: 12 },
  { globalId: '0AAAAAAAAAAAAAAAAAAAA3', expressId: 13 },
]
const byExpress = new Map(ELEMENTS.map((e) => [e.expressId, e]))
const byGlobal = new Map(ELEMENTS.map((e) => [e.globalId, e.expressId]))

class StubCamera implements ViewpointCameraTarget {
  snapshot: CameraSnapshot
  constructor(snapshot: CameraSnapshot) {
    this.snapshot = { ...snapshot }
  }
  setPosition(x: number, y: number, z: number): void {
    this.snapshot.position = { x, y, z }
  }
  setTarget(x: number, y: number, z: number): void {
    this.snapshot.target = { x, y, z }
  }
  setUp(x: number, y: number, z: number): void {
    this.snapshot.up = { x, y, z }
  }
  setFOV(fov: number): void {
    this.snapshot.fovRadians = fov
  }
  setProjectionMode(mode: 'perspective' | 'orthographic'): void {
    this.snapshot.projection = mode
  }
  setOrthoSize(size: number): void {
    this.snapshot.orthoHalfHeight = size
  }
  getDistance(): number {
    const { position: p, target: t } = this.snapshot
    return Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z)
  }
}

const PERSPECTIVE: CameraSnapshot = {
  position: { x: 10, y: 5, z: -20 },
  target: { x: 10, y: 5, z: -30 },
  up: { x: 0, y: 1, z: 0 },
  fovRadians: Math.PI / 3,
  projection: 'perspective',
  orthoHalfHeight: 12.5,
  aspect: 1.6,
}

function state(overrides: Partial<CaptureState> = {}): CaptureState {
  return {
    camera: PERSPECTIVE,
    section: null,
    bounds: null,
    visibility: NOTHING_HIDDEN,
    selected: new Set(),
    frame: RTC,
    elementsByExpressId: byExpress,
    ...overrides,
  }
}

const hasNegativeZero = (value: unknown): boolean =>
  typeof value === 'number'
    ? Object.is(value, -0)
    : value !== null && typeof value === 'object'
      ? Object.values(value).some(hasNegativeZero)
      : false

describe('captureViewpoint truncation', () => {
  const many = (count: number) => {
    const elements = new Map(ELEMENTS.map((e) => [e.expressId, e]))
    elements.clear()
    for (let id = 1; id <= count; id += 1) elements.set(id, { globalId: String(id).padStart(22, 'A'), expressId: id })
    return elements
  }

  it('says nothing was cut when the lists fit', () => {
    expect(captureViewpoint(state()).truncated).toEqual({ selection: false, exceptions: false })
  })

  it('flags a selection over 500 and keeps the first 500', () => {
    const vp = captureViewpoint(state({ elementsByExpressId: many(501), selected: new Set(many(501).keys()) }))
    expect(vp.truncated).toEqual({ selection: true, exceptions: false })
    expect(vp.components.selection.globalIds).toHaveLength(500)
  })

  it('flags an isolation over 2000 elements: the stored list is a part of it', () => {
    const all = many(2001)
    const vp = captureViewpoint(state({ elementsByExpressId: all, visibility: { hidden: new Set(), isolated: new Set(all.keys()) } }))
    expect(vp.truncated.exceptions).toBe(true)
    expect(vp.components.visibility.exceptions).toHaveLength(2000)
    expect(vp.components.visibility.defaultVisibility).toBe(false)
  })
})

describe('captureViewpoint camera', () => {
  it('maps a perspective camera into IFC world, Z-up', () => {
    const { camera } = captureViewpoint(state())
    expect(camera).toEqual({
      type: 'perspective',
      // render (10, 5, -20) -> Z-up local (10, 20, 5) -> + (2683000, 1245000, 0)
      position: { x: 2683010, y: 1245020, z: 5 },
      // render (0, 0, -1) -> IFC (0, 1, 0): looking along +Y, north
      direction: { x: 0, y: 1, z: 0 },
      // render up (0, 1, 0) -> IFC (0, 0, 1)
      up: { x: 0, y: 0, z: 1 },
      fieldOfView: expect.closeTo(60, 9),
      aspectRatio: 1.6,
    })
  })

  it('treats originShift as Y-up and the RTC offset as Z-up', () => {
    const { camera } = captureViewpoint(
      state({
        frame: SHIFTED,
        camera: { ...PERSPECTIVE, position: { x: 1, y: 2, z: 3 }, target: { x: 1, y: 2, z: 2 } },
      })
    )
    // Total offset in IFC axes: shift (100, 7, -30) Y-up -> (100, 30, 7), plus
    // rtc (2683000, 1245000, 50) = (2683100, 1245030, 57).
    // Render (1, 2, 3) -> local (1, -3, 2) -> (2683101, 1245027, 59).
    expect(camera.position).toEqual({ x: 2683101, y: 1245027, z: 59 })
    // Directions never take the offset.
    expect(camera.direction).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('is the identity for a zero frame, with no negative zero anywhere', () => {
    for (const frame of [null, {}, { originShift: null, wasmRtcOffset: null }]) {
      const vp = captureViewpoint(
        state({
          frame,
          camera: { ...PERSPECTIVE, position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -1 } },
          section: { atMetres: 0, flipped: false },
        })
      )
      expect(vp.camera.position).toEqual({ x: 0, y: 0, z: 0 })
      expect(vp.camera.direction).toEqual({ x: 0, y: 1, z: 0 })
      expect(hasNegativeZero(vp)).toBe(false)
    }
  })

  it('pins the orthographic convention: wire scale is the full height, 2 x getOrthoSize()', () => {
    const { camera } = captureViewpoint(
      state({ camera: { ...PERSPECTIVE, projection: 'orthographic', orthoHalfHeight: 12.5 } })
    )
    expect(camera.type).toBe('orthographic')
    if (camera.type !== 'orthographic') return
    expect(camera.viewToWorldScale).toBe(25)
  })

  it('clamps the aspect ratio into the wire range', () => {
    expect(captureViewpoint(state({ camera: { ...PERSPECTIVE, aspect: 0 } })).camera.aspectRatio).toBe(0.1)
    expect(captureViewpoint(state({ camera: { ...PERSPECTIVE, aspect: 99 } })).camera.aspectRatio).toBe(10)
  })
})

describe('section plane', () => {
  const bounds = { min: { x: 0, y: -3, z: -40 }, max: { x: 20, y: 9, z: 0 } }

  it('points toward the hidden half: +Z unflipped (the renderer discards above the cut)', () => {
    const { clippingPlanes } = captureViewpoint(
      state({ section: { atMetres: 1.2, flipped: false }, bounds })
    )
    // centre render (10, _, -20) -> IFC (10, 20); height is the cut itself.
    expect(clippingPlanes).toEqual([
      { location: { x: 2683010, y: 1245020, z: 1.2 }, direction: { x: 0, y: 0, z: 1 } },
    ])
  })

  it('flips the direction when flipped, and shifts the height by the frame Z offset', () => {
    const { clippingPlanes } = captureViewpoint(
      state({ section: { atMetres: 1.2, flipped: true }, bounds, frame: { wasmRtcOffset: { x: 0, y: 0, z: 50 } } })
    )
    expect(clippingPlanes[0]?.direction).toEqual({ x: 0, y: 0, z: -1 })
    expect(clippingPlanes[0]?.location.z).toBeCloseTo(51.2, 12)
  })

  it('emits no plane without a section', () => {
    expect(captureViewpoint(state()).clippingPlanes).toEqual([])
  })
})

describe('components', () => {
  it('captures selection and drops ids the index does not know', () => {
    const vp = captureViewpoint(state({ selected: new Set([11, 13, 999]) }))
    expect(vp.components.selection.globalIds).toEqual([ELEMENTS[0]!.globalId, ELEMENTS[2]!.globalId])
  })

  it('hidden: visible by default, the hidden ones are exceptions', () => {
    const vp = captureViewpoint(state({ visibility: { hidden: new Set([12]), isolated: null } }))
    expect(vp.components.visibility).toEqual({
      defaultVisibility: true,
      exceptions: [ELEMENTS[1]!.globalId],
    })
  })

  it('isolated: hidden by default, the isolated ones are exceptions (minus hidden)', () => {
    const vp = captureViewpoint(
      state({ visibility: { hidden: new Set([13]), isolated: new Set([11, 13]) } })
    )
    expect(vp.components.visibility).toEqual({
      defaultVisibility: false,
      exceptions: [ELEMENTS[0]!.globalId],
    })
  })
})

describe('restoreViewpoint', () => {
  const context = { frame: RTC, expressIdByGlobalId: byGlobal }
  const fresh = (): StubCamera =>
    new StubCamera({
      ...PERSPECTIVE,
      position: { x: 0, y: 0, z: 5 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    })

  it('puts the camera back at the render-frame pose', () => {
    const camera = fresh()
    restoreViewpoint(captureViewpoint(state()), camera, context)
    expect(camera.snapshot.position).toEqual({ x: 10, y: 5, z: -20 })
    expect(camera.snapshot.up).toEqual({ x: 0, y: 1, z: 0 })
    expect(camera.snapshot.projection).toBe('perspective')
    expect(camera.snapshot.fovRadians).toBeCloseTo(Math.PI / 3, 12)
    // The target keeps the viewer's current reach along the viewpoint direction.
    expect(camera.snapshot.target.x).toBeCloseTo(10, 9)
    expect(camera.snapshot.target.z).toBeCloseTo(-25, 9)
  })

  it('maps a horizontal plane back to a section and ignores the rest', () => {
    const vp = captureViewpoint(state({ section: { atMetres: 1.2, flipped: true } }))
    vp.clippingPlanes.push({
      location: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    })
    const restored = restoreViewpoint(vp, fresh(), context)
    expect(restored.section).toEqual({ atMetres: 1.2, flipped: true })
    expect(restored.ignoredPlanes).toBe(1)
  })

  it('counts unresolved GlobalIds in missing without throwing', () => {
    const vp = captureViewpoint(state())
    vp.components.selection.globalIds = [ELEMENTS[0]!.globalId, 'NOTINMODELNOTINMODEL01']
    vp.components.visibility = {
      defaultVisibility: false,
      exceptions: [ELEMENTS[1]!.globalId, ELEMENTS[2]!.globalId, 'NOTINMODELNOTINMODEL01'],
    }
    const restored = restoreViewpoint(vp, fresh(), context)
    expect(restored.missing).toBe(1) // the same absent id, counted once
    expect(restored.selected).toEqual(new Set([11]))
    expect(restored.visibility).toEqual({ hidden: new Set(), isolated: new Set([12, 13]) })
  })

  it('restores hidden as a hidden set with nothing isolated', () => {
    const vp = captureViewpoint(state({ visibility: { hidden: new Set([12]), isolated: null } }))
    expect(restoreViewpoint(vp, fresh(), context).visibility).toEqual({
      hidden: new Set([12]),
      isolated: null,
    })
  })
})

describe('round trip', () => {
  const bounds = { min: { x: 0, y: -3, z: -40 }, max: { x: 20, y: 9, z: 0 } }
  const cases: [string, CaptureState][] = [
    ['perspective', state({ frame: SHIFTED })],
    [
      'orthographic with a flipped section at 1.2 m',
      state({
        frame: SHIFTED,
        camera: {
          ...PERSPECTIVE,
          projection: 'orthographic',
          orthoHalfHeight: 7.25,
          position: { x: 3, y: 40, z: -12 },
          target: { x: 3, y: 0, z: -12 },
          up: { x: 0, y: 0, z: -1 },
        },
        section: { atMetres: 1.2, flipped: true },
        bounds,
      }),
    ],
    [
      'isolated and selected',
      state({
        visibility: { hidden: new Set(), isolated: new Set([11, 12]) },
        selected: new Set([12]),
      }),
    ],
  ]

  it.each(cases)('%s survives capture, restore into a fresh camera, capture', (_name, input) => {
    const first = captureViewpoint(input)
    const camera = new StubCamera({
      ...PERSPECTIVE,
      position: { x: -9, y: 3, z: 8 },
      target: { x: 1, y: 1, z: 1 },
    })
    const restored = restoreViewpoint(first, camera, {
      frame: input.frame,
      expressIdByGlobalId: byGlobal,
    })
    expect(restored.missing).toBe(0)
    const second = captureViewpoint({
      ...input,
      camera: { ...camera.snapshot, aspect: input.camera.aspect },
      section: restored.section,
      visibility: restored.visibility,
      selected: restored.selected,
    })
    const a = first.camera
    const b = second.camera
    for (const key of ['position', 'direction', 'up'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(Math.abs(a[key][axis] - b[key][axis])).toBeLessThan(1e-6)
      }
    }
    if (a.type === 'perspective' && b.type === 'perspective') {
      expect(Math.abs(a.fieldOfView - b.fieldOfView)).toBeLessThan(1e-6)
    }
    if (a.type === 'orthographic' && b.type === 'orthographic') {
      expect(Math.abs(a.viewToWorldScale - b.viewToWorldScale)).toBeLessThan(1e-6)
    }
    expect(second.clippingPlanes).toEqual(first.clippingPlanes)
    expect(second.components).toEqual(first.components)
  })
})
