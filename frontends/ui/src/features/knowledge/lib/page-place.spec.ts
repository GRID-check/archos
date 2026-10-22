/**
 * A place's geometry: the box converted to the viewer's corners, the clip a
 * thumbnail draws around it, and the routes the page is read from.
 */
import { describe, expect, test } from 'vitest'
import { CLIP_ASPECT, placeBox, placeClip, placeFileUrl, placePreviewUrl, placeRegions, type PagePlace } from './page-place'

const place = (overrides: Partial<PagePlace> = {}): PagePlace => ({
  document: { id: 'doc-1', name: 'Grundriss EG.pdf', shelf: 'stored' },
  page: 2,
  frame: 'page',
  region: [0.6, 0.1, 0.2, 0.1],
  ...overrides,
})

describe('placeBox and placeRegions', () => {
  test('a box [x, y, w, h] becomes the viewer’s [x0, y0, x1, y1], with its label', () => {
    const box = placeBox(place())!
    expect(box.map((v) => Number(v.toFixed(6)))).toEqual([0.6, 0.1, 0.8, 0.2])
    expect(placeRegions(place({ label: 'Plankopf' }))).toEqual([{ box, label: 'Plankopf' }])
  })

  test('a whole page, a box on an embedded image and a malformed box mark nothing', () => {
    expect(placeRegions(place({ region: null }))).toEqual([])
    expect(placeRegions(place({ frame: 'image', imageIndex: 0 }))).toEqual([])
    expect(placeRegions(place({ region: [0.5, 0.5, 0, 0.2] }))).toEqual([])
    expect(placeRegions(place({ region: [0.5, 0.5, 2, 0.2] }))).toEqual([])
  })

  test('a pointer is a small box around it', () => {
    const [x0, y0, x1, y1] = placeBox(place({ region: null, point: [0.5, 0.5] }))!
    expect(x0).toBeLessThan(0.5)
    expect(x1).toBeGreaterThan(0.5)
    expect(y0).toBeLessThan(0.5)
    expect(y1).toBeGreaterThan(0.5)
  })
})

describe('placeClip', () => {
  const page = { width: 1000, height: 700 }

  test('the whole page without a box', () => {
    expect(placeClip(page, null)).toEqual({ crop: { x: 0, y: 0, width: 1000, height: 700 }, mark: null })
  })

  test('the box with a margin, at the thumbnail’s aspect, the box inside it', () => {
    const { crop, mark } = placeClip(page, [0.4, 0.4, 0.5, 0.45])
    expect(crop.width / crop.height).toBeCloseTo(CLIP_ASPECT, 5)
    expect(mark!.x).toBeGreaterThan(0)
    expect(mark!.y).toBeGreaterThan(0)
    expect(mark!.x + mark!.width).toBeLessThan(crop.width)
    expect(mark!.y + mark!.height).toBeLessThan(crop.height)
    // The box is in the middle of the clip.
    expect(crop.x + mark!.x + mark!.width / 2).toBeCloseTo(450, 5)
  })

  test('a box at the corner keeps the clip on the page', () => {
    const { crop } = placeClip(page, [0.9, 0.9, 1, 1])
    expect(crop.x + crop.width).toBeCloseTo(1000, 5)
    expect(crop.y + crop.height).toBeCloseTo(700, 5)
  })

  test('a box larger than the page fits in it', () => {
    const { crop } = placeClip(page, [0, 0, 1, 1])
    expect(crop).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })
})

describe('the routes a place is read from', () => {
  test('a stored document’s stream, a named Fassung’s, a corpus file, and none without an id', () => {
    expect(placeFileUrl(place())).toBe('/api/documents/doc-1/file')
    expect(placeFileUrl(place({ revisionId: 'v-7' }))).toBe('/api/documents/doc-1/versions/v-7/file')
    expect(placeFileUrl(place({ document: { id: null, name: 'OIB RL 2.pdf', shelf: 'base' } }))).toBe(
      '/api/knowledge-base/documents/OIB%20RL%202.pdf'
    )
    expect(placeFileUrl(place({ document: { id: null, name: 'x.pdf', shelf: 'stored' } }))).toBeNull()
    expect(placePreviewUrl(place())).toBe('/api/documents/doc-1/preview')
    expect(placePreviewUrl(place({ document: { id: null, name: 'x.pdf', shelf: 'base' } }))).toBeNull()
  })
})
