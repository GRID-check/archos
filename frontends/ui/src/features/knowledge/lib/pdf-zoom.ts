/**
 * The viewer's zoom and page arithmetic, kept pure so it can be pinned by a
 * spec without a document, a layout or a pointer.
 *
 * Zoom is a multiple of the FIT, not of print size. The fit is one of two: the
 * page's width fills the frame (reading a Bescheid), or the whole page fits it
 * (looking at a plan sheet). 100% is always "fitted", so nothing claims to be
 * 1:1 that is not — the same convention the Fassungen comparison uses.
 */

export type FitMode = 'width' | 'page'

/**
 * The rungs the buttons and the keys walk. A pinch moves freely between the
 * ends. The ladder runs past what most documents may use: the ceiling a
 * document actually gets is {@link maxZoomFor}, and a rung above it is never
 * offered.
 */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const
export const MIN_ZOOM = ZOOM_STEPS[0]
/** The ceiling for a document whose size is not known yet, and the floor of every document's own ceiling. */
export const MAX_ZOOM = 8
/** No document goes past this, however large its sheet: a sheet this deep is a few glyphs across. */
export const ABSOLUTE_MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 32

/** CSS pixels per PDF point at print size: 96 CSS px to the inch, 72 points to the inch. */
export const PRINT_SCALE = 96 / 72

/**
 * How large past print size the deepest zoom draws a sheet. Twice print size
 * puts the 2.5 mm lettering of an A1 plan at about 19 CSS px, a size a reader
 * on site can take in at arm's length, in glare.
 */
export const MAX_PRINT_MAGNIFICATION = 2

/**
 * The deepest zoom THIS document gets, as a multiple of its fit.
 *
 * A fixed ceiling is the wrong question. Zoom is a multiple of the fit, and
 * the fit of an A1 plan on a 393px phone is about 0.15 CSS px per point, so a
 * ceiling of 4 left 2.5 mm text at four pixels, a third of what it takes to
 * read it. The ceiling that answers the reader is one in PAPER terms: deep
 * enough that the sheet is drawn at {@link MAX_PRINT_MAGNIFICATION} times its
 * printed size. A Bescheid on a laptop is past that already at the fit, so
 * {@link MAX_ZOOM} stays the floor, and {@link ABSOLUTE_MAX_ZOOM} the roof.
 */
export function maxZoomFor(options: { pageWidth: number | null; fitWidth: number }): number {
  const { pageWidth, fitWidth } = options
  if (!pageWidth || pageWidth <= 0 || !Number.isFinite(fitWidth) || fitWidth <= 0) return MAX_ZOOM
  const printZoom = (MAX_PRINT_MAGNIFICATION * PRINT_SCALE * pageWidth) / fitWidth
  return Math.min(ABSOLUTE_MAX_ZOOM, Math.max(MAX_ZOOM, printZoom))
}

/** `zoom` held to the ladder's ends (`max` the document's own ceiling); garbage is the fit. */
export function clampZoom(zoom: number, max: number = MAX_ZOOM): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(Math.max(zoom, MIN_ZOOM), Math.max(max, MIN_ZOOM))
}

/**
 * The next rung above (`direction` 1) or below (-1). From between two rungs —
 * after a pinch — it goes to the nearer rung in that direction, never skips
 * one, and stays put at an end. The document's ceiling is an end too: the
 * rung above it is the ceiling itself.
 */
export function stepZoom(zoom: number, direction: 1 | -1, max: number = MAX_ZOOM): number {
  const current = clampZoom(zoom, max)
  const epsilon = 1e-6
  if (direction > 0) {
    const next = ZOOM_STEPS.find((step) => step > current + epsilon) ?? max
    return Math.min(next, max)
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon) ?? MIN_ZOOM
}

/** How far one double tap reaches into a sheet. */
export const DOUBLE_TAP_FACTOR = 2.5

/**
 * Where a double tap takes the zoom: one step of {@link DOUBLE_TAP_FACTOR}
 * deeper, anchored on the finger, until the ceiling, where the next double tap
 * fits the sheet again. A plan sheet is read by diving towards a detail in a
 * few taps and surfacing in one; the Photos convention (one tap in, one tap
 * out) would leave an A1 detail out of reach.
 */
export function doubleTapZoom(zoom: number, max: number = MAX_ZOOM): number {
  const current = clampZoom(zoom, max)
  if (current >= max * 0.98) return 1
  if (current < 1) return 1
  return Math.min(max, current * DOUBLE_TAP_FACTOR)
}

/** Where a two-finger tap takes the zoom: one double tap back out, never past the fit. */
export function twoFingerTapZoom(zoom: number, max: number = MAX_ZOOM): number {
  const current = clampZoom(zoom, max)
  return Math.max(1, Math.min(current, current / DOUBLE_TAP_FACTOR))
}

/** How hard a pinch past an end is resisted: the exponent the excess is raised to. */
const RUBBER_BAND = 0.35

/**
 * The zoom a pinch SHOWS while it is held past an end: the excess compressed,
 * so the sheet gives a little and pulls back on release, the way a native
 * viewer says „this is the end" without a wall. Inside the ends it is the
 * zoom itself.
 */
export function rubberBandZoom(zoom: number, max: number = MAX_ZOOM): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  const ceiling = Math.max(max, MIN_ZOOM)
  if (zoom > ceiling) return ceiling * Math.pow(zoom / ceiling, RUBBER_BAND)
  if (zoom < MIN_ZOOM) return MIN_ZOOM * Math.pow(zoom / MIN_ZOOM, RUBBER_BAND)
  return zoom
}

/**
 * The transform that shows content scaled by `scale` about a point that
 * follows the fingers: `point` is where the gesture took hold of the content,
 * in the content's own (untransformed) pixels, `origin` is where the content's
 * top-left corner is on screen, and `at` is where that point must be now. With
 * `transform-origin: 0 0`, `translate(x, y) scale(scale)` puts it there.
 */
export function anchoredTransform(options: {
  scale: number
  point: { x: number; y: number }
  origin: { x: number; y: number }
  at: { x: number; y: number }
}): { x: number; y: number; scale: number } {
  const { scale, point, origin, at } = options
  return { x: at.x - origin.x - scale * point.x, y: at.y - origin.y - scale * point.y, scale }
}

/** Whether `zoom` is the fit, give or take a pinch's rounding. */
export const isFitted = (zoom: number): boolean => Math.abs(zoom - 1) < 0.01

/** `page` held to 1..`count`. */
export function clampPage(page: number, count: number): number {
  const last = Math.max(1, Math.trunc(count) || 1)
  const whole = Math.trunc(page)
  return Math.min(Math.max(Number.isFinite(whole) ? whole : 1, 1), last)
}

/**
 * The width a page is drawn at before zoom.
 *
 * Fit width: the frame less the gutter the page's shadow and the scrollbar
 * need. Fit page: the narrower of that and the width at which the page's
 * HEIGHT fits the frame, so a portrait sheet in a landscape frame shows whole.
 */
export function fitWidth(options: {
  mode: FitMode
  frameWidth: number
  frameHeight: number
  aspect: number
  gutter: number
  verticalPadding: number
}): number {
  const { mode, frameWidth, frameHeight, aspect, gutter, verticalPadding } = options
  const byWidth = Math.max(0, frameWidth - gutter)
  if (mode === 'width' || frameHeight <= verticalPadding || aspect <= 0) return byWidth
  return Math.min(byWidth, (frameHeight - verticalPadding) / aspect)
}

/** What a key press inside the viewer asks for, or null when it is not the viewer's. */
export type ViewerKeyAction =
  | { kind: 'page'; to: 'next' | 'previous' | 'first' | 'last' }
  | { kind: 'zoom'; direction: 1 | -1 }
  | { kind: 'fit' }
  | { kind: 'search' }

/**
 * Map a key press to a viewer action.
 *
 * Scoped by the caller: this is only consulted for events that reached the
 * focused viewer, so Cmd+F and Cmd+0 are taken from the browser only while the
 * reader is inside the document. Typing into a field (the page number, the
 * search query) keeps every key but the ones that leave the field.
 *
 * Left and right turn the page only when the page does not overflow
 * sideways: zoomed in on a plan, they are what scrolls it.
 */
export function viewerKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  context: { inField: boolean; overflowsSideways: boolean },
): ViewerKeyAction | null {
  const command = event.ctrlKey || event.metaKey
  if (event.altKey) return null
  if (command && event.key.toLowerCase() === 'f') return { kind: 'search' }
  if (context.inField) return null
  if (command && event.key === '0') return { kind: 'fit' }
  if (event.key === '+' || event.key === '=') return { kind: 'zoom', direction: 1 }
  if (event.key === '-' || event.key === '_') return { kind: 'zoom', direction: -1 }
  if (command) return null
  switch (event.key) {
    case 'PageDown':
      return { kind: 'page', to: 'next' }
    case 'PageUp':
      return { kind: 'page', to: 'previous' }
    case 'Home':
      return { kind: 'page', to: 'first' }
    case 'End':
      return { kind: 'page', to: 'last' }
    case 'ArrowRight':
      return context.overflowsSideways ? null : { kind: 'page', to: 'next' }
    case 'ArrowLeft':
      return context.overflowsSideways ? null : { kind: 'page', to: 'previous' }
    default:
      return null
  }
}
