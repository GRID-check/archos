import type { PageSize } from '../types'

/**
 * Zoom as a multiple of "the whole sheet fits the pane" (1). Not a percentage
 * of print size: the label says „Einpassen" at 1 and a percentage of that fit
 * everywhere else, so nothing claims to be 1:1 that is not.
 *
 * The buttons walk this ladder; Ctrl + wheel and a pinch move freely between
 * its ends. 16x, because a plotted A1 sheet fitted to a 393px phone is about
 * 0.43 CSS px per millimetre: 8x, enough on a laptop, leaves its 2.5 mm
 * lettering at 8.6 px there, and 16x at 17. Past the canvas budget the page
 * is drawn soft and the part on screen sharp (`page-canvas.tsx`).
 */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const
export const FIT_ZOOM = 1
export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 16

/** `zoom` held to the ladder's ends; garbage is the fit. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return FIT_ZOOM
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM)
}

/**
 * The next rung above (`direction` 1) or below (-1) `zoom`. From between two
 * rungs (after a pinch) it goes to the nearer rung in that direction, never
 * skips one, and stays put at an end.
 */
export function nextZoom(zoom: number, direction: 1 | -1): number {
  const current = clampZoom(zoom)
  const epsilon = 1e-6
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + epsilon) ?? MAX_ZOOM
  return [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon) ?? MIN_ZOOM
}

/** Whether `zoom` is the fit, give or take a pinch's rounding. */
export const isFitZoom = (zoom: number): boolean => Math.abs(zoom - FIT_ZOOM) < 0.01

/** `page` held to 1..`count`; a document with no pages still has a page 1 to stand on. */
export function clampPage(page: number, count: number): number {
  const last = Math.max(1, Math.trunc(count) || 1)
  const whole = Math.trunc(page)
  return Math.min(Math.max(Number.isFinite(whole) ? whole : 1, 1), last)
}

/** The shared page range of two Fassungen, and whether they disagree on its length. */
export function pageSpan(
  olderCount: number,
  newerCount: number,
): { count: number; differs: boolean } {
  return {
    count: Math.max(olderCount, newerCount, 1),
    differs: olderCount !== newerCount,
  }
}

/** Whether a document of `count` pages has page `page`. */
export function hasPage(count: number, page: number): boolean {
  return page >= 1 && page <= count
}

/**
 * The box both pages fit in: the widest and the tallest of the two.
 *
 * Both are drawn at ONE scale inside it, top-left aligned, so a wall that did
 * not move lands on the same pixel in either; fitting each page to the width on
 * its own would stretch the smaller sheet and fake a change everywhere.
 */
export function commonStage(sizes: readonly PageSize[]): PageSize | null {
  if (sizes.length === 0) return null
  return {
    width: Math.max(...sizes.map((size) => size.width)),
    height: Math.max(...sizes.map((size) => size.height)),
  }
}

/**
 * CSS pixels per natural unit that fit `stage` into `available`, times the zoom.
 *
 * Fit-to-contain when the height is known, so at 100 % a reader sees the whole
 * sheet and not its top half; fit-to-width when it is not (a phone, where the
 * panes stack and scroll).
 */
export function fitScale(
  available: { width: number; height?: number },
  stage: PageSize,
  zoom: number,
): number {
  if (available.width <= 0 || stage.width <= 0 || stage.height <= 0) return 0
  const byWidth = available.width / stage.width
  const byHeight =
    available.height !== undefined && available.height > 0
      ? available.height / stage.height
      : Number.POSITIVE_INFINITY
  return Math.min(byWidth, byHeight) * zoom
}
