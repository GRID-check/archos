/**
 * How big a bitmap a page may have, and which part of it is drawn sharp.
 *
 * A page is drawn twice over once it is zoomed deep:
 *
 *  - the BASE, the whole page in one canvas, at device resolution for as long
 *    as that fits the canvas budget and softer past it. It is what a pinch
 *    stretches and a fast pan shows, so it must always exist and must never
 *    blow the budget;
 *  - the DETAIL, one canvas over the part of the page on screen (plus a margin
 *    a short pan does not leave), at full device resolution. It exists only
 *    while the base is softer than the screen.
 *
 * This is the shape pdf.js's own viewer settled on (`maxCanvasPixels` plus its
 * detail view), for the same reason: iOS Safari draws nothing at all for a
 * canvas past about 16.7 million pixels, and an A1 plan at twelve times its fit
 * on a DPR 3 phone is over a hundred million. The browser does not complain; the
 * page is simply blank. Kept pure, so the decisions can be held by a spec.
 */

/** Device pixels per CSS pixel past which a raster buys nothing a screen shows. */
export const MAX_PIXEL_RATIO = 3

/**
 * The pixel budget of one canvas on a phone or tablet: pdf.js's own value for
 * iOS and Android (5 MiP). Far under Safari's 16.7M hard limit, because a phone
 * also holds the neighbouring pages, the detail canvas and whatever else the
 * tab draws inside one total canvas memory allowance.
 */
export const TOUCH_MAX_CANVAS_PIXELS = 5 * 1024 * 1024

/** The pixel budget of one canvas on a desktop: Safari's hard limit, so a Mac draws it too. */
export const DESKTOP_MAX_CANVAS_PIXELS = 4096 * 4096

/**
 * The budget for this device. A coarse pointer is the honest proxy: it is the
 * memory class of the device that matters, and every phone and tablet answers
 * coarse while a laptop with a touch screen still answers fine.
 */
export function maxCanvasPixels(coarsePointer: boolean): number {
  return coarsePointer ? TOUCH_MAX_CANVAS_PIXELS : DESKTOP_MAX_CANVAS_PIXELS
}

/** The device's pixel ratio, held to {@link MAX_PIXEL_RATIO}; garbage is 1. */
export function devicePixelRatioOf(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return 1
  return Math.min(value, MAX_PIXEL_RATIO)
}

/** A bitmap for a box: how many device pixels per CSS pixel, and its size in pixels. */
export interface Raster {
  ratio: number
  width: number
  height: number
  /** True when the budget, not the screen, decided the ratio: the bitmap is softer than the device. */
  capped: boolean
}

/**
 * The bitmap for a `width` × `height` CSS box: the device ratio, or less, so
 * the pixel count stays inside `maxPixels`.
 */
export function rasterFor(options: {
  width: number
  height: number
  dpr: number
  maxPixels: number
}): Raster {
  const { width, height, maxPixels } = options
  const dpr = devicePixelRatioOf(options.dpr)
  if (width <= 0 || height <= 0) return { ratio: dpr, width: 0, height: 0, capped: false }
  const budgetRatio = Math.sqrt(maxPixels / (width * height))
  const ratio = Math.min(dpr, budgetRatio)
  return {
    ratio,
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    capped: budgetRatio < dpr,
  }
}

/**
 * Whether a bitmap already drawn is still the right one. Within two pixels is
 * the same: a capped base keeps its pixel count as the zoom grows, and
 * re-drawing a whole A1 sheet for a rounding difference is a second of an
 * iPhone's time spent on nothing.
 */
export function sameRaster(
  drawn: { width: number; height: number },
  wanted: { width: number; height: number }
): boolean {
  return Math.abs(drawn.width - wanted.width) <= 2 && Math.abs(drawn.height - wanted.height) <= 2
}

/** A rectangle in a page's own CSS pixels, top-left origin. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The part of a page on screen, in the page's own CSS pixels; null when none of it is. */
export function visiblePart(page: Box, view: Box): Box | null {
  const left = Math.max(page.x, view.x)
  const top = Math.max(page.y, view.y)
  const right = Math.min(page.x + page.width, view.x + view.width)
  const bottom = Math.min(page.y + page.height, view.y + view.height)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left - page.x, y: top - page.y, width: right - left, height: bottom - top }
}

/** How much of the view's size is drawn beyond it on every side, so a short pan stays sharp. */
export const DETAIL_MARGIN = 0.5

/** A region of a page to draw sharp, and its bitmap. */
export interface DetailPlan {
  region: Box
  raster: Raster
}

/**
 * The detail canvas a page needs, or null when it needs none.
 *
 * None when the base is already at device resolution (the budget did not cap
 * it), and none when no part of the page is on screen. Otherwise the visible
 * part grown by {@link DETAIL_MARGIN} of the view on every side, cut to the
 * page, and shrunk back towards the visible part until it fits the budget at
 * device resolution. If even the visible part does not (a 5K display at 2x),
 * it keeps the visible part and gives up resolution instead: a slightly soft
 * detail beats a blank one.
 */
export function detailPlan(options: {
  /** The page's size in CSS pixels, as laid out. */
  page: { width: number; height: number }
  /** The part of the page on screen (see {@link visiblePart}). */
  visible: Box | null
  /** The base bitmap the page has. */
  base: Raster
  dpr: number
  maxPixels: number
}): DetailPlan | null {
  const { page, visible, base, maxPixels } = options
  const dpr = devicePixelRatioOf(options.dpr)
  // A base within a few percent of the screen is sharp enough; a second
  // canvas for the difference is memory spent on nothing anyone sees.
  if (!visible || !base.capped || base.ratio >= dpr * 0.95 || page.width <= 0 || page.height <= 0)
    return null
  const budget = maxPixels / (dpr * dpr)
  let margin = DETAIL_MARGIN
  let region = grow(visible, page, margin)
  // Halve the margin until the region fits; the visible part itself is the floor.
  for (let step = 0; step < 6 && region.width * region.height > budget; step += 1) {
    margin /= 2
    region = grow(visible, page, margin)
  }
  if (region.width * region.height > budget) region = visible
  return {
    region,
    raster: rasterFor({ width: region.width, height: region.height, dpr, maxPixels }),
  }
}

/** `box` grown by `margin` of its own size on every side, cut to the page. */
function grow(box: Box, page: { width: number; height: number }, margin: number): Box {
  const dx = box.width * margin
  const dy = box.height * margin
  const x = Math.max(0, box.x - dx)
  const y = Math.max(0, box.y - dy)
  const right = Math.min(page.width, box.x + box.width + dx)
  const bottom = Math.min(page.height, box.y + box.height + dy)
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * Whether a detail drawn for `drawn` (in the page's CSS pixels at `drawnWidth`)
 * still covers `visible` at the page's current width: the same zoom, and the
 * screen still inside it. A pan inside the margin keeps the bitmap; a zoom, or
 * a pan out of the margin, asks for a new one.
 */
export function detailCovers(options: {
  drawn: Box
  drawnWidth: number
  pageWidth: number
  visible: Box | null
}): boolean {
  const { drawn, drawnWidth, pageWidth, visible } = options
  if (!visible) return true
  if (Math.abs(drawnWidth - pageWidth) > 0.5) return false
  return (
    visible.x >= drawn.x - 0.5 &&
    visible.y >= drawn.y - 0.5 &&
    visible.x + visible.width <= drawn.x + drawn.width + 0.5 &&
    visible.y + visible.height <= drawn.y + drawn.height + 0.5
  )
}
