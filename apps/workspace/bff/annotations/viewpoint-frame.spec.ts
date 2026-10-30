/**
 * @vitest-environment node
 */
/** The framing core (`./viewpoint-frame.ts`): hand-computed numbers and a frustum check done independently. */
import { describe, expect, it } from 'vitest'
import {
  frameViewpoint,
  ViewpointFrameError,
  VIEW_ELEVATION_DEG,
  type Box3,
} from './viewpoint-frame'
import { viewpointInputSchema, type Vec3 } from './viewpoint-types'

const id = (n: number) => `${'A'.repeat(21)}${String.fromCharCode(97 + (n % 26))}`
const box = (n: number, min: Vec3, max: Vec3): Box3 => ({ globalId: id(n), min, max })
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
const unitCube = box(0, v(10, 20, 3), v(11, 21, 4))

function perspective(input: ReturnType<typeof frameViewpoint>) {
  if (input.camera.type !== 'perspective') throw new Error('expected perspective')
  return input.camera
}

describe('frameViewpoint by hand', () => {
  it('puts a unit cube at the distance sqrt(3)/2 / sin(30 deg) with fov 60 and margin 1', () => {
    // r = sqrt(3)/2, narrower half angle = 30 deg (aspect 1), distance = r / 0.5 = sqrt(3).
    const cam = perspective(frameViewpoint([unitCube], { margin: 1, aspectRatio: 1, fieldOfView: 60 }))
    const centre = v(10.5, 20.5, 3.5)
    const d = Math.hypot(cam.position.x - centre.x, cam.position.y - centre.y, cam.position.z - centre.z)
    expect(d).toBeCloseTo(Math.sqrt(3), 9)
    // Elevation 30 deg: height above the centre is d * 0.5; azimuth 225: equal, negative x and y.
    expect(cam.position.z - centre.z).toBeCloseTo(Math.sqrt(3) * 0.5, 9)
    const horizontal = Math.sqrt(3) * Math.cos((VIEW_ELEVATION_DEG * Math.PI) / 180)
    expect(cam.position.x - centre.x).toBeCloseTo(-horizontal / Math.SQRT2, 9)
    expect(cam.position.y - centre.y).toBeCloseTo(-horizontal / Math.SQRT2, 9)
  })

  it('uses the horizontal half angle when the frame is narrow, and the default margin 1.15', () => {
    // aspect 1/2: tan(h) = tan(30) * 0.5 = 0.288675; sin(h) = 0.288675 / sqrt(1 + 0.083333) = 0.277350.
    const cam = perspective(frameViewpoint([unitCube], { aspectRatio: 0.5 }))
    const expected = (1.15 * (Math.sqrt(3) / 2)) / 0.2773500981
    const centre = v(10.5, 20.5, 3.5)
    const d = Math.hypot(cam.position.x - centre.x, cam.position.y - centre.y, cam.position.z - centre.z)
    expect(d).toBeCloseTo(expected, 6)
  })

  it('looks at the centre with Z up, selects the ids and hides nothing', () => {
    const out = frameViewpoint([unitCube, unitCube, box(1, v(0, 0, 0), v(1, 1, 1))])
    const cam = perspective(out)
    expect(cam.up).toEqual(v(0, 0, 1))
    expect(Math.hypot(cam.direction.x, cam.direction.y, cam.direction.z)).toBeCloseTo(1, 12)
    expect(out.components.selection.globalIds).toEqual([id(0), id(1)])
    expect(out.components.visibility).toEqual({ defaultVisibility: true, exceptions: [] })
    expect(out.clippingPlanes).toEqual([])
  })

  it('builds six outward planes around the padded union when asked', () => {
    const out = frameViewpoint([unitCube], { section: true, sectionPadding: 0.25 })
    expect(out.clippingPlanes).toHaveLength(6)
    expect(out.clippingPlanes).toContainEqual({ location: v(11.25, 20.5, 3.5), direction: v(1, 0, 0) })
    expect(out.clippingPlanes).toContainEqual({ location: v(10.5, 19.75, 3.5), direction: v(0, -1, 0) })
    expect(out.clippingPlanes).toContainEqual({ location: v(10.5, 20.5, 4.25), direction: v(0, 0, 1) })
  })

  it('passes the wire schema, with and without a section', () => {
    for (const section of [false, true]) {
      expect(() => viewpointInputSchema.parse(frameViewpoint([unitCube], { section }))).not.toThrow()
    }
  })
})

describe('frameViewpoint refuses', () => {
  const code = (fn: () => unknown) => {
    try {
      fn()
    } catch (e) {
      return e instanceof ViewpointFrameError ? e.code : 'other'
    }
    return 'none'
  }
  it.each([
    ['empty', () => frameViewpoint([])],
    ['degenerate', () => frameViewpoint([box(0, v(1, 1, 1), v(1, 1, 1))])],
    ['too_large', () => frameViewpoint([box(0, v(0, 0, 0), v(1e6, 0, 0))])],
    ['not_finite', () => frameViewpoint([box(0, v(NaN, 0, 0), v(1, 1, 1))])],
    ['inverted', () => frameViewpoint([box(0, v(2, 0, 0), v(1, 1, 1))])],
  ])('%s', (expected, fn) => {
    expect(code(fn)).toBe(expected)
  })

  it('accepts a flat, zero-volume box (a slab face)', () => {
    expect(() => frameViewpoint([box(0, v(0, 0, 0), v(5, 5, 0))])).not.toThrow()
  })
})

describe('the box lies inside the view frustum', () => {
  // A small deterministic generator, so a failure reproduces.
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32

  it('for random boxes, fields of view and aspects', () => {
    const next = rng(42)
    for (let i = 0; i < 300; i++) {
      const min = v((next() - 0.5) * 2000, (next() - 0.5) * 2000, next() * 100)
      const size = v(0.01 + next() * 80, 0.01 + next() * 80, next() * 30)
      const max = v(min.x + size.x, min.y + size.y, min.z + size.z)
      const fov = 20 + next() * 100
      const aspect = 0.4 + next() * 2.5
      const cam = perspective(frameViewpoint([box(0, min, max)], { fieldOfView: fov, aspectRatio: aspect }))

      // Camera basis computed here, not taken from the code under test.
      const f = cam.direction
      const right = norm(cross(f, v(0, 0, 1)))
      const up = cross(right, f)
      const tv = Math.tan((fov * Math.PI) / 360)
      const th = tv * aspect
      for (const x of [min.x, max.x])
        for (const y of [min.y, max.y])
          for (const z of [min.z, max.z]) {
            const p = v(x - cam.position.x, y - cam.position.y, z - cam.position.z)
            const depth = dot(p, f)
            expect(depth).toBeGreaterThan(0)
            expect(Math.abs(dot(p, right))).toBeLessThanOrEqual(th * depth + 1e-9)
            expect(Math.abs(dot(p, up))).toBeLessThanOrEqual(tv * depth + 1e-9)
          }
    }
  })
})

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}
function norm(a: Vec3): Vec3 {
  const l = Math.sqrt(dot(a, a))
  return v(a.x / l, a.y / l, a.z / l)
}
