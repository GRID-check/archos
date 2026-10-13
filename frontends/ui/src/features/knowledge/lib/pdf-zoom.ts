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

/** The rungs the buttons and the keys walk. A pinch moves freely between the ends. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4

/** `zoom` held to the ladder's ends; garbage is the fit. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM)
}

/**
 * The next rung above (`direction` 1) or below (-1). From between two rungs —
 * after a pinch — it goes to the nearer rung in that direction, never skips
 * one, and stays put at an end.
 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const current = clampZoom(zoom)
  const epsilon = 1e-6
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + epsilon) ?? MAX_ZOOM
  return [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon) ?? MIN_ZOOM
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
