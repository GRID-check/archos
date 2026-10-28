

import { type HighlightRect } from '../lib/passage-highlight'

import { devicePixelRatioOf, maxCanvasPixels } from '../lib/pdf-raster'

/** A point on a page, as a share of the page as the viewer shows it, top-left origin. */
export interface PagePoint {
  page: number
  x: number
  y: number
}

/** The point a click at (`clientX`, `clientY`) hit on a page whose box is `rect`, clamped onto the page. */
export function pointOnPage(
  page: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  clientX: number,
  clientY: number,
): PagePoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return {
    page,
    x: clamp((clientX - rect.left) / rect.width),
    y: clamp((clientY - rect.top) / rect.height),
  }
}

/**
 * How far either side of the cited page the passage is still looked for.
 *
 * The page number is somebody else's arithmetic: retrieval counts sheets, and
 * a document whose own numbering starts after a cover page — which is most of
 * them — is off by one against it; a title sheet plus a table of contents make
 * it two. That mismatch used to cost the reader the entire feature, silently:
 * the viewer opened at the wrong page with nothing marked, indistinguishable
 * from a passage that could not be found at all.
 *
 * The radius stays at 0 until the cited page itself comes up empty, widens to
 * one page either side then, and to two only once both neighbours have come up
 * empty as well — so the second ring is looked at only after the first has
 * answered, never speculatively. Two is the ceiling: the matchers are strict
 * enough that a neighbour either holds the quoted sentence or holds nothing,
 * so looking next door cannot invent a hit, but three pages out is no longer a
 * numbering offset, it is a different passage that happens to read alike.
 *
 * Derived from the misses rather than stored, so a new Fundstelle resets it
 * with them and no state can disagree with what the pages actually reported.
 */
export const MAX_SEARCH_RADIUS = 2

export function searchRadius(
  page: number | null | undefined,
  missed: readonly number[],
  numPages: number,
): number {
  if (!page || !missed.includes(page)) return 0
  const neighbours = pagesWithin(page, 1, numPages).filter((number) => number !== page)
  return neighbours.every((number) => missed.includes(number)) ? MAX_SEARCH_RADIUS : 1
}

/** The page numbers within `radius` of `page` that the document actually has. */
export function pagesWithin(page: number, radius: number, numPages: number): number[] {
  const pages: number[] = []
  for (let number = page - radius; number <= page + radius; number += 1) {
    if (number >= 1 && number <= numPages) pages.push(number)
  }
  return pages
}

/**
 * The proportion of the loading placeholder: an ISO 216 page (A4, A3, …), the
 * shape almost every Austrian Norm, Richtlinie and Bescheid comes in. Wrong
 * for a landscape plan, which then changes shape once; right for the rest,
 * which do not move at all when the first page lands.
 */
export const PLACEHOLDER_PAGE_ASPECT = Math.SQRT2

/** Horizontal room left for the page shadow and the scrollbar. */
export const GUTTER = 24

/**
 * The same on a touch screen, whose scrollbars overlay the content and take no
 * room: only the shadow's. Twenty-four pixels of a 393px phone is six percent
 * of a drawing's width spent on a scrollbar that is not there.
 */
export const TOUCH_GUTTER = 8

/**
 * How far outside the viewport a page rasterises, and how far past it a page
 * keeps its bitmap. One band for both directions gives the eviction enough
 * hysteresis that an ordinary scroll does not thrash it.
 */
export const PRERENDER_MARGIN = '150% 0px'

/** Where a located passage comes to rest in the frame — high, but with lead-in. */
export const PASSAGE_SCROLL_OFFSET = 0.28

/**
 * How long the view has to stand still before the pages on screen draw their
 * sharp detail. Long enough that a flick's momentum is over, short enough that
 * the reader who stopped to read does not wait for it.
 */
export const DETAIL_SETTLE_MS = 120

/**
 * The band, as a share of the frame, that decides which page the reader is ON.
 * A thin strip across the middle: whatever crosses it is what they are reading,
 * and only one page can be there at a time, so the counter never flickers
 * between two pages the way a "most visible" rule does at a page boundary.
 */
export const CURRENT_PAGE_BAND = '-45% 0px -45% 0px'

/** How long a copied-confirmation stays up before the bar goes quiet again. */
export const COPIED_FEEDBACK_MS = 1600

/** Shorter than this, a selection is a mis-click rather than a quotation. */
export const MIN_QUOTE_LENGTH = 3

export interface PassageHit {
  page: number
  rects: HighlightRect[]
  /**
   * The mark is the software's best guess, not the passage verbatim: a
   * windowed or partial match. A reader verifying a citation needs to see the
   * difference, so the mark wears it.
   */
  fuzzy: boolean
}

/** A selection the reader made, and where to hang the offer to quote it. */
export interface QuoteSelection {
  text: string
  page: number
  /** Top-left of the selection, in the page stack's own coordinates. */
  x: number
  y: number
}

/** Vertical room the stage keeps around a page fitted whole: the padding above it and the pill below. */
export const FIT_PAGE_PADDING = 80

/** How long a zoom waits before re-rasterising, so a pinch re-draws once and not every frame. */
export const RERASTER_DELAY_MS = 140

/** How long a typed query waits before the document is searched. */
export const SEARCH_DEBOUNCE_MS = 180

/** How long the page has to stay put before it is announced. */
export const ANNOUNCE_DELAY_MS = 400

/** One of the reader's own search hits. */
export interface SearchHit {
  page: number
  rects: HighlightRect[]
}

/**
 * Where a zoom is anchored, so the point under the fingers stays under them.
 *
 * Held as a share of the PAGE it is on, not as a point of the page stack: the
 * gaps between pages do not grow with the zoom, so a stack point scaled by the
 * zoom ratio drifts by a gap per page above it, and on page 40 of a Bescheid
 * that was a screen and a half.
 */
export interface ZoomAnchor {
  /** The point in the frame's visible box. */
  x: number
  y: number
  /** The page it is on, and where on that page, as shares; null off every page. */
  page: number | null
  fx: number
  fy: number
  /** The same point in the page stack, before the zoom, for when it is on no page. */
  contentX: number
  contentY: number
  ratio: number
  /** The zoom on screen when it was asked for, so the change can be played rather than cut. */
  shown: number
}

/** A view-moved signal: the pages on screen subscribe, the frame publishes. No React state per scroll. */
export interface ViewSignal {
  subscribe: (listener: () => void) => () => void
  emit: () => void
}

export const createViewSignal = (): ViewSignal => {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: () => listeners.forEach((listener) => listener()),
  }
}

/** The canvas budget of this device (`pdf-raster.ts`): a phone's, or a desktop's. */
export const canvasBudget = (): number =>
  maxCanvasPixels(typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false)

export const screenRatio = (): number => devicePixelRatioOf(typeof window === 'undefined' ? 1 : window.devicePixelRatio)

/** Whether the reader asked for less motion; a zoom then cuts instead of gliding. */
export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export type LoadState = 'loading' | 'ready' | 'failed' | 'locked' | 'wrong-password'

/** pdf.js says "this document needs a password" with a `PasswordException`; code 2 is "that one was wrong". */
export const passwordState = (error: unknown): 'locked' | 'wrong-password' | null => {
  if (typeof error !== 'object' || error === null) return null
  const { name, code } = error as { name?: unknown; code?: unknown }
  if (name !== 'PasswordException') return null
  return code === 2 ? 'wrong-password' : 'locked'
}

/** Smooth scrolling is motion, and a reader who asked for less of it gets a jump. */
export const scrollBehavior = (smooth: boolean): ScrollBehavior => {
  if (!smooth) return 'auto'
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth'
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/**
 * Which page a point of the page stack is on, and where on it, as shares of
 * the page. The page whose rows hold the point, or else the nearest one; the
 * horizontal share is left unclamped, so a point beside a narrow page stays
 * beside it.
 */
export function pageShare(
  pages: ReadonlyMap<number, HTMLElement>,
  x: number,
  y: number,
): { page: number | null; fx: number; fy: number } {
  let best: { page: number; node: HTMLElement; distance: number } | null = null
  for (const [page, node] of pages) {
    if (node.offsetHeight <= 0 || node.offsetWidth <= 0) continue
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    const distance = y < top ? top - y : y > bottom ? y - bottom : 0
    if (!best || distance < best.distance) best = { page, node, distance }
    if (distance === 0) break
  }
  if (!best) return { page: null, fx: 0, fy: 0 }
  const { node } = best
  return {
    page: best.page,
    fx: (x - node.offsetLeft) / node.offsetWidth,
    fy: Math.min(1, Math.max(0, (y - node.offsetTop) / node.offsetHeight)),
  }
}
