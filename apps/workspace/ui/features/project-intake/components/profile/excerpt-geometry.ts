/**
 * Which part of a cited page the Steckbrief shows beside a value: the quoted
 * passage with enough of the page around it to see what it belongs to (the
 * title block it sits in, the line above it), or the whole page, small, when
 * the quote is not found in the page's text (a scan, a quote the reading
 * paraphrased). Pure, in the page's own units at scale 1, top-left origin, the
 * space `passageBounds` answers in.
 */

import type { Box } from '@/features/knowledge/lib/pdf-raster'

export interface Excerpt {
  /** The part of the page to draw. */
  crop: Box
  /** The passage, relative to `crop`; null when the whole page is shown. */
  mark: Box | null
}

/** At least this share of the page's width is shown, so a short quote is not a word on a blank strip. */
export const MIN_WIDTH_SHARE = 0.5
/** Margin around the passage, as a share of the page's size, at least. */
export const MARGIN_SHARE = 0.06
/** Never flatter than this (width over height): a single line still shows the lines around it. */
export const MAX_ASPECT = 3

function clampSpan(start: number, length: number, total: number): [number, number] {
  const span = Math.min(length, total)
  const from = Math.min(Math.max(0, start), total - span)
  return [from, span]
}

/** Grow a span around its centre to `length`, kept inside `[0, total]`. */
function grow(start: number, span: number, length: number, total: number): [number, number] {
  if (span >= length) return clampSpan(start, span, total)
  return clampSpan(start - (length - span) / 2, length, total)
}

export function excerptOf(page: { width: number; height: number }, passage: Box | null): Excerpt {
  const whole: Excerpt = { crop: { x: 0, y: 0, width: page.width, height: page.height }, mark: null }
  if (!passage || page.width <= 0 || page.height <= 0 || passage.width <= 0 || passage.height <= 0) return whole

  const marginX = Math.max(page.width * MARGIN_SHARE, passage.width * 0.1)
  const marginY = Math.max(page.height * MARGIN_SHARE, passage.height * 2)
  let [x, width] = clampSpan(passage.x - marginX, passage.width + 2 * marginX, page.width)
  ;[x, width] = grow(x, width, page.width * MIN_WIDTH_SHARE, page.width)
  let [y, height] = clampSpan(passage.y - marginY, passage.height + 2 * marginY, page.height)
  ;[y, height] = grow(y, height, width / MAX_ASPECT, page.height)

  return {
    crop: { x, y, width, height },
    mark: { x: passage.x - x, y: passage.y - y, width: passage.width, height: passage.height },
  }
}
