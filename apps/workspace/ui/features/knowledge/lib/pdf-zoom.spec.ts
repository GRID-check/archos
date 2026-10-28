import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_MAX_ZOOM,
  MAX_ZOOM,
  anchoredTransform,
  clampPage,
  clampZoom,
  doubleTapZoom,
  fitWidth,
  maxZoomFor,
  rubberBandZoom,
  stepZoom,
  twoFingerTapZoom,
  viewerKeyAction,
} from './pdf-zoom'

const key = (key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
})
const outside = { inField: false, overflowsSideways: false }

describe('stepZoom', () => {
  it('walks the ladder one rung at a time and stops at its ends', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.75)
    expect(stepZoom(8, 1)).toBe(8)
    expect(stepZoom(0.5, -1)).toBe(0.5)
  })

  it('from between two rungs, after a pinch, goes to the nearer rung that way', () => {
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1.1, -1)).toBe(1)
  })

  it('treats garbage as the fit', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(-2)).toBe(1)
    expect(clampZoom(40)).toBe(MAX_ZOOM)
  })

  it('walks past 8 for a document whose ceiling is deeper, and stops at that ceiling', () => {
    expect(stepZoom(8, 1, 17.2)).toBe(12)
    expect(stepZoom(12, 1, 17.2)).toBe(16)
    expect(stepZoom(16, 1, 17.2)).toBe(17.2)
    expect(stepZoom(17.2, 1, 17.2)).toBe(17.2)
    expect(stepZoom(17.2, -1, 17.2)).toBe(16)
    expect(clampZoom(40, 17.2)).toBe(17.2)
  })
})

/** An A1 sheet across (841 mm) in PDF points, and its fit on a 393px phone (frame 381 less the 24px gutter). */
const A1_WIDTH = 2384
const A4_WIDTH = 595
const PHONE_FIT = 357

describe('maxZoomFor', () => {
  it('lets an A1 plan on a phone go deep enough to read 2.5 mm lettering', () => {
    const ceiling = maxZoomFor({ pageWidth: A1_WIDTH, fitWidth: PHONE_FIT })
    // The finding: fit x 4 left 2.5 mm text at about 4 px. Twice print size is ~19 px.
    expect(ceiling).toBeGreaterThan(12)
    const pxPerMm = (PHONE_FIT * ceiling) / 841
    expect(2.5 * pxPerMm).toBeGreaterThanOrEqual(18)
  })

  it('keeps 8x as the floor for a Bescheid, which is legible long before', () => {
    expect(maxZoomFor({ pageWidth: A4_WIDTH, fitWidth: PHONE_FIT })).toBe(MAX_ZOOM)
    expect(maxZoomFor({ pageWidth: A4_WIDTH, fitWidth: 1000 })).toBe(MAX_ZOOM)
  })

  it('never passes the absolute ceiling, and falls back before the first page is known', () => {
    expect(maxZoomFor({ pageWidth: 14_400, fitWidth: 200 })).toBe(ABSOLUTE_MAX_ZOOM)
    expect(maxZoomFor({ pageWidth: null, fitWidth: PHONE_FIT })).toBe(MAX_ZOOM)
    expect(maxZoomFor({ pageWidth: A1_WIDTH, fitWidth: 0 })).toBe(MAX_ZOOM)
  })
})

describe('doubleTapZoom', () => {
  it('dives in steps towards the ceiling and surfaces to the fit from it', () => {
    expect(doubleTapZoom(1, 17)).toBe(2.5)
    expect(doubleTapZoom(2.5, 17)).toBe(6.25)
    expect(doubleTapZoom(6.25, 17)).toBe(15.625)
    expect(doubleTapZoom(15.625, 17)).toBe(17)
    expect(doubleTapZoom(17, 17)).toBe(1)
  })

  it('goes to the fit from below it', () => {
    expect(doubleTapZoom(0.5, 8)).toBe(1)
  })

  it('two fingers tap one step back out, never past the fit', () => {
    expect(twoFingerTapZoom(6.25, 17)).toBe(2.5)
    expect(twoFingerTapZoom(1.5, 17)).toBe(1)
    expect(twoFingerTapZoom(1, 17)).toBe(1)
  })
})

describe('rubberBandZoom', () => {
  it('is the zoom itself inside the ends', () => {
    expect(rubberBandZoom(3, 8)).toBe(3)
  })

  it('gives a little past the ceiling and past the floor, never the whole way', () => {
    const past = rubberBandZoom(16, 8)
    expect(past).toBeGreaterThan(8)
    expect(past).toBeLessThan(11)
    const under = rubberBandZoom(0.25, 8)
    expect(under).toBeLessThan(0.5)
    expect(under).toBeGreaterThan(0.35)
  })
})

describe('anchoredTransform', () => {
  it('keeps the held point under the fingers as they spread and move', () => {
    const point = { x: 200, y: 300 }
    const origin = { x: 10, y: 50 }
    const at = { x: 260, y: 420 }
    const transform = anchoredTransform({ scale: 2.5, point, origin, at })
    // With transform-origin 0 0 the point lands at origin + translate + scale * point.
    expect(origin.x + transform.x + transform.scale * point.x).toBeCloseTo(at.x)
    expect(origin.y + transform.y + transform.scale * point.y).toBeCloseTo(at.y)
  })

  it('is the identity for a pinch that has not moved', () => {
    expect(anchoredTransform({ scale: 1, point: { x: 5, y: 7 }, origin: { x: 0, y: 0 }, at: { x: 5, y: 7 } })).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    })
  })
})

describe('clampPage', () => {
  it('holds a page to the document', () => {
    expect(clampPage(0, 5)).toBe(1)
    expect(clampPage(9, 5)).toBe(5)
    expect(clampPage(2.7, 5)).toBe(2)
  })
})

describe('fitWidth', () => {
  const frame = { frameWidth: 1024, frameHeight: 600, aspect: Math.SQRT2, gutter: 24, verticalPadding: 80 }

  it('fills the width less the gutter', () => {
    expect(fitWidth({ ...frame, mode: 'width' })).toBe(1000)
  })

  it('fits a portrait page whole by its height', () => {
    expect(fitWidth({ ...frame, mode: 'page' })).toBeCloseTo(520 / Math.SQRT2)
  })

  it('never fits a page wider than the frame', () => {
    expect(fitWidth({ ...frame, mode: 'page', frameHeight: 5000 })).toBe(1000)
  })
})

describe('viewerKeyAction', () => {
  it('turns pages', () => {
    expect(viewerKeyAction(key('PageDown'), outside)).toEqual({ kind: 'page', to: 'next' })
    expect(viewerKeyAction(key('PageUp'), outside)).toEqual({ kind: 'page', to: 'previous' })
    expect(viewerKeyAction(key('Home'), outside)).toEqual({ kind: 'page', to: 'first' })
    expect(viewerKeyAction(key('End'), outside)).toEqual({ kind: 'page', to: 'last' })
  })

  it('leaves left and right to scrolling once the page is wider than the frame', () => {
    expect(viewerKeyAction(key('ArrowRight'), outside)).toEqual({ kind: 'page', to: 'next' })
    expect(viewerKeyAction(key('ArrowRight'), { ...outside, overflowsSideways: true })).toBeNull()
  })

  it('zooms, fits and searches', () => {
    expect(viewerKeyAction(key('+'), outside)).toEqual({ kind: 'zoom', direction: 1 })
    expect(viewerKeyAction(key('='), outside)).toEqual({ kind: 'zoom', direction: 1 })
    expect(viewerKeyAction(key('-'), outside)).toEqual({ kind: 'zoom', direction: -1 })
    expect(viewerKeyAction(key('0', { ctrlKey: true }), outside)).toEqual({ kind: 'fit' })
    expect(viewerKeyAction(key('f', { metaKey: true }), outside)).toEqual({ kind: 'search' })
    expect(viewerKeyAction(key('0'), outside)).toBeNull()
  })

  it('lets a field keep its keys, except the one that searches', () => {
    const inField = { inField: true, overflowsSideways: false }
    expect(viewerKeyAction(key('End'), inField)).toBeNull()
    expect(viewerKeyAction(key('-'), inField)).toBeNull()
    expect(viewerKeyAction(key('F', { ctrlKey: true }), inField)).toEqual({ kind: 'search' })
  })

  it('stays out of the way of Alt chords', () => {
    expect(viewerKeyAction(key('PageDown', { altKey: true }), outside)).toBeNull()
  })
})
