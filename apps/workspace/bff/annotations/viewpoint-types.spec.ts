/**
 * @vitest-environment node
 */
/** The bounds of the viewpoint wire schemas: each refusal the table's CHECKs repeat, and each a client can hit first. */
import { describe, expect, it } from 'vitest'
import { createAnnotationRequestSchema } from './types'
import { viewpointInputSchema, MAX_SNAPSHOT_BASE64 } from './viewpoint-types'

const ID = '2O2Fr$t4X7Zf8NOew3FLOH'
const ids = (count: number) => Array.from({ length: count }, (_, index) => `${String(index).padStart(22, 'A')}`)

const camera = {
  type: 'perspective' as const,
  position: { x: 1, y: 2, z: 3 },
  direction: { x: 0, y: 1, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fieldOfView: 60,
  aspectRatio: 1.5,
}
const components = { selection: { globalIds: [ID] }, visibility: { defaultVisibility: true, exceptions: [] }, coloring: [] }
const viewpoint = (patch: Record<string, unknown> = {}) => ({ camera, components, ...patch })
const accepts = (value: unknown) => viewpointInputSchema.safeParse(value).success

describe('the viewpoint request', () => {
  it('takes a complete view and defaults the section planes to none', () => {
    const parsed = viewpointInputSchema.parse(viewpoint())
    expect(parsed.clippingPlanes).toEqual([])
  })

  it('takes an orthographic camera with its scale', () => {
    const { fieldOfView: _, ...shared } = camera
    expect(accepts(viewpoint({ camera: { ...shared, type: 'orthographic', viewToWorldScale: 12 } }))).toBe(true)
    expect(accepts(viewpoint({ camera: { ...shared, type: 'orthographic', viewToWorldScale: 0 } }))).toBe(false)
    expect(accepts(viewpoint({ camera: { ...shared, type: 'orthographic' } }))).toBe(false)
  })

  it.each([
    ['a field of view under 1 degree', { ...camera, fieldOfView: 0.5 }],
    ['a field of view of 180 degrees', { ...camera, fieldOfView: 180 }],
    ['an aspect ratio under 0.1', { ...camera, aspectRatio: 0.05 }],
    ['an aspect ratio over 10', { ...camera, aspectRatio: 11 }],
    ['a coordinate over 1e7', { ...camera, position: { x: 1e7 + 1, y: 0, z: 0 } }],
    ['a coordinate that is not finite', { ...camera, position: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } }],
    ['a zero direction', { ...camera, direction: { x: 0, y: 0, z: 0 } }],
    ['a zero up vector', { ...camera, up: { x: 0, y: 0, z: 0 } }],
    ['an up vector parallel to the direction', { ...camera, up: { x: 0, y: 2, z: 0 } }],
    ['an unknown camera field', { ...camera, zoom: 2 }],
    ['an unknown camera type', { ...camera, type: 'fisheye' }],
  ])('refuses %s', (_, bad) => {
    expect(accepts(viewpoint({ camera: bad }))).toBe(false)
  })

  it('limits the section planes to six, and each plane needs a direction', () => {
    const plane = { location: { x: 0, y: 0, z: 1.2 }, direction: { x: 0, y: 0, z: 1 } }
    expect(accepts(viewpoint({ clippingPlanes: Array(6).fill(plane) }))).toBe(true)
    expect(accepts(viewpoint({ clippingPlanes: Array(7).fill(plane) }))).toBe(false)
    expect(accepts(viewpoint({ clippingPlanes: [{ ...plane, direction: { x: 0, y: 0, z: 0 } }] }))).toBe(false)
  })

  it('limits the selection to 500 distinct GlobalIds', () => {
    const withSelection = (globalIds: string[]) => viewpoint({ components: { ...components, selection: { globalIds } } })
    expect(accepts(withSelection(ids(500)))).toBe(true)
    expect(accepts(withSelection(ids(501)))).toBe(false)
    expect(accepts(withSelection([ID, ID]))).toBe(false)
    expect(accepts(withSelection(['too-short']))).toBe(false)
    expect(accepts(withSelection(['0123456789012345678901!']))).toBe(false)
  })

  it('limits the visibility exceptions to 2000', () => {
    const withExceptions = (exceptions: string[]) =>
      viewpoint({ components: { ...components, visibility: { defaultVisibility: false, exceptions } } })
    expect(accepts(withExceptions(ids(2000)))).toBe(true)
    expect(accepts(withExceptions(ids(2001)))).toBe(false)
  })

  it('limits the colouring to sixteen groups of hex colours', () => {
    const group = { color: 'FF0000', globalIds: [ID] }
    const withColoring = (coloring: unknown[]) => viewpoint({ components: { ...components, coloring } })
    expect(accepts(withColoring(Array(16).fill(group)))).toBe(true)
    expect(accepts(withColoring(Array(17).fill(group)))).toBe(false)
    expect(accepts(withColoring([{ color: '#FF0000', globalIds: [] }]))).toBe(false)
    expect(accepts(withColoring([{ color: '80FF0000', globalIds: [] }]))).toBe(true)
  })

  it('takes a pin with a point, and an element only as an option', () => {
    expect(accepts(viewpoint({ pin: { point: { x: 1, y: 1, z: 1 }, globalId: ID } }))).toBe(true)
    expect(accepts(viewpoint({ pin: { globalId: ID } }))).toBe(false)
  })

  it('takes a snapshot of an image type, within the encoded cap', () => {
    const snapshot = (contentType: string, length: number) => ({ contentType, dataBase64: 'A'.repeat(length) })
    expect(accepts(viewpoint({ snapshot: snapshot('image/png', MAX_SNAPSHOT_BASE64) }))).toBe(true)
    expect(accepts(viewpoint({ snapshot: snapshot('image/png', MAX_SNAPSHOT_BASE64 + 1) }))).toBe(false)
    expect(accepts(viewpoint({ snapshot: snapshot('image/gif', 10) }))).toBe(false)
    expect(accepts(viewpoint({ snapshot: snapshot('image/png', 0) }))).toBe(false)
  })

  it('refuses a field it does not know', () => {
    expect(accepts(viewpoint({ model: 'x' }))).toBe(false)
  })
})

describe('the create request with a viewpoint', () => {
  const content = { kind: 'hint', body: 'Lintel missing.' }

  it('takes a viewpoint instead of a box', () => {
    expect(createAnnotationRequestSchema.safeParse({ ...content, viewpoint: viewpoint() }).success).toBe(true)
  })

  it('takes exactly one of a box, elementIds or a viewpoint', () => {
    const box = { page: 1, shape: 'point', x: 0.1, y: 0.1 }
    expect(createAnnotationRequestSchema.safeParse({ ...content, ...box, viewpoint: viewpoint() }).success).toBe(false)
    expect(createAnnotationRequestSchema.safeParse({ ...content, elementIds: ['a'], viewpoint: viewpoint() }).success).toBe(false)
    expect(createAnnotationRequestSchema.safeParse({ ...content }).success).toBe(false)
  })
})
