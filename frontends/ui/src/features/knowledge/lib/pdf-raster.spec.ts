import { describe, expect, it } from 'vitest'
import {
  DESKTOP_MAX_CANVAS_PIXELS,
  TOUCH_MAX_CANVAS_PIXELS,
  detailCovers,
  detailPlan,
  devicePixelRatioOf,
  maxCanvasPixels,
  rasterFor,
  sameRaster,
  visiblePart,
} from './pdf-raster'

/** Safari on iOS draws nothing at all for a canvas past this. */
const IOS_CANVAS_LIMIT = 16_777_216

/** An A1 landscape sheet fitted to a 393px phone: 357 x 252 CSS px. */
const A1_FIT = { width: 357, height: 252 }
const PHONE = { x: 0, y: 0, width: 393, height: 700 }

describe('the canvas budget', () => {
  it("is pdf.js's mobile budget on a coarse pointer, and inside Safari's hard limit everywhere", () => {
    expect(maxCanvasPixels(true)).toBe(TOUCH_MAX_CANVAS_PIXELS)
    expect(maxCanvasPixels(false)).toBe(DESKTOP_MAX_CANVAS_PIXELS)
    expect(DESKTOP_MAX_CANVAS_PIXELS).toBeLessThanOrEqual(IOS_CANVAS_LIMIT)
  })

  it('draws at DPR 3, where the old viewer stopped at 2, and never past it', () => {
    expect(devicePixelRatioOf(3)).toBe(3)
    expect(devicePixelRatioOf(4)).toBe(3)
    expect(devicePixelRatioOf(undefined)).toBe(1)
  })
})

describe('rasterFor', () => {
  it('draws a fitted A1 sheet at full device resolution', () => {
    const raster = rasterFor({ ...A1_FIT, dpr: 3, maxPixels: TOUCH_MAX_CANVAS_PIXELS })
    expect(raster.ratio).toBe(3)
    expect(raster.capped).toBe(false)
  })

  it('caps the base of a deep zoom inside the budget instead of going blank', () => {
    // The finding's case: A1 at 12x its fit on a DPR 3 phone.
    const zoomed = { width: A1_FIT.width * 12, height: A1_FIT.height * 12 }
    const uncapped = zoomed.width * zoomed.height * 9
    expect(uncapped).toBeGreaterThan(IOS_CANVAS_LIMIT)
    const raster = rasterFor({ ...zoomed, dpr: 3, maxPixels: TOUCH_MAX_CANVAS_PIXELS })
    expect(raster.capped).toBe(true)
    expect(raster.width * raster.height).toBeLessThanOrEqual(TOUCH_MAX_CANVAS_PIXELS)
    expect(raster.ratio).toBeLessThan(3)
  })

  it('keeps a capped base the same size as the zoom grows, so it is not drawn again', () => {
    const at = (zoom: number) =>
      rasterFor({
        width: A1_FIT.width * zoom,
        height: A1_FIT.height * zoom,
        dpr: 3,
        maxPixels: TOUCH_MAX_CANVAS_PIXELS,
      })
    expect(sameRaster(at(8), at(12))).toBe(true)
    expect(sameRaster(at(1), at(2))).toBe(false)
  })
})

describe('visiblePart', () => {
  it("is the page's own pixels on screen, or nothing", () => {
    expect(visiblePart({ x: -500, y: -200, width: 4000, height: 3000 }, PHONE)).toEqual({
      x: 500,
      y: 200,
      width: 393,
      height: 700,
    })
    expect(visiblePart({ x: 0, y: 900, width: 393, height: 300 }, PHONE)).toBeNull()
  })
})

describe('detailPlan', () => {
  const deep = { width: A1_FIT.width * 12, height: A1_FIT.height * 12 }
  const base = rasterFor({ ...deep, dpr: 3, maxPixels: TOUCH_MAX_CANVAS_PIXELS })
  const visible = visiblePart({ x: -1500, y: -900, ...deep }, PHONE)

  it('draws the part on screen sharp, at device resolution, inside the budget', () => {
    const plan = detailPlan({
      page: deep,
      visible,
      base,
      dpr: 3,
      maxPixels: TOUCH_MAX_CANVAS_PIXELS,
    })
    expect(plan).not.toBeNull()
    expect(plan!.raster.ratio).toBe(3)
    expect(plan!.raster.width * plan!.raster.height).toBeLessThanOrEqual(TOUCH_MAX_CANVAS_PIXELS)
    // It covers the screen, with some margin a short pan does not leave.
    expect(
      detailCovers({ drawn: plan!.region, drawnWidth: deep.width, pageWidth: deep.width, visible })
    ).toBe(true)
    expect(plan!.region.width).toBeGreaterThan(visible!.width)
  })

  it('asks for none while the base is sharp, or when the page is off screen', () => {
    const fitted = rasterFor({ ...A1_FIT, dpr: 3, maxPixels: TOUCH_MAX_CANVAS_PIXELS })
    expect(
      detailPlan({
        page: A1_FIT,
        visible: { x: 0, y: 0, ...A1_FIT },
        base: fitted,
        dpr: 3,
        maxPixels: TOUCH_MAX_CANVAS_PIXELS,
      })
    ).toBeNull()
    expect(
      detailPlan({ page: deep, visible: null, base, dpr: 3, maxPixels: TOUCH_MAX_CANVAS_PIXELS })
    ).toBeNull()
  })

  it('gives up resolution rather than the screen when even the screen does not fit the budget', () => {
    const huge = { width: 20_000, height: 20_000 }
    const screen = { x: 0, y: 0, width: 3000, height: 2000 }
    const plan = detailPlan({
      page: huge,
      visible: screen,
      base: rasterFor({ ...huge, dpr: 2, maxPixels: TOUCH_MAX_CANVAS_PIXELS }),
      dpr: 2,
      maxPixels: TOUCH_MAX_CANVAS_PIXELS,
    })
    expect(plan!.region).toEqual(screen)
    expect(plan!.raster.width * plan!.raster.height).toBeLessThanOrEqual(TOUCH_MAX_CANVAS_PIXELS)
  })
})

describe('detailCovers', () => {
  const drawn = { x: 100, y: 100, width: 800, height: 1200 }
  it('keeps the detail for a pan inside its margin', () => {
    expect(
      detailCovers({
        drawn,
        drawnWidth: 4000,
        pageWidth: 4000,
        visible: { x: 200, y: 300, width: 393, height: 700 },
      })
    ).toBe(true)
  })

  it('asks again for a pan out of it, and for any zoom', () => {
    expect(
      detailCovers({
        drawn,
        drawnWidth: 4000,
        pageWidth: 4000,
        visible: { x: 600, y: 300, width: 393, height: 700 },
      })
    ).toBe(false)
    expect(
      detailCovers({
        drawn,
        drawnWidth: 4000,
        pageWidth: 4800,
        visible: { x: 200, y: 300, width: 393, height: 700 },
      })
    ).toBe(false)
  })
})
