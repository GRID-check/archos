/**
 * A place on a document: a page, and on it a box or a point, or the whole page
 * (ADR-0128). What Piloti looked at, what it showed the room, and, from V5 on,
 * where a cited passage sits.
 *
 * A place is an ADDRESS, never pixels: the document (its id on the office's
 * shelves, or its file name in the platform corpus), the page, the box. The
 * browser draws it from the document's own routes, so the reader sees the
 * place exactly when they may open the document.
 *
 * The box is `[x, y, w, h]`, shares of the page as shown, origin top left: the
 * frame `look`, the Fokusbereich and an Anmerkung's region share. The viewer's
 * own {@link PageRegion} is `[x0, y0, x1, y1]`; {@link placeRegions} converts.
 */

import type { Box } from './pdf-raster'
import type { PageRegion } from './page-region'

export interface PlaceDocument {
  /** The stored document's id; null for the platform corpus, or when it was not resolved. */
  id: string | null
  name: string
  /** `stored`: a document of the office or the project; `base`: the platform corpus. */
  shelf: 'stored' | 'base'
}

export interface PagePlace {
  document: PlaceDocument
  /** From 1. */
  page: number
  /** `page`: the box is on the page as shown; `image`: on an image embedded in it. */
  frame: 'page' | 'image'
  /** `[x, y, w, h]` as shares of the frame; null for the whole page. */
  region: readonly number[] | null
  /** `[x, y]` of a pointer, as shares of the page. */
  point?: readonly number[] | null
  /** The embedded image, for frame `image`. */
  imageIndex?: number | null
  /** The Fassung; absent means the document's current one. */
  revisionId?: string | null
  /** A label drawn beside the box. */
  label?: string | null
}

/** The width-to-height ratio a thumbnail's clip aims for. */
export const CLIP_ASPECT = 3 / 2
/** Margin around the box, as a share of the box's own size, at least. */
const BOX_MARGIN = 0.35
/** And as a share of the page, at least, so a tiny box still shows what it sits in. */
const PAGE_MARGIN = 0.04
/** Half the side of the square a pointer is drawn as, as a share of the page. */
const POINT_HALF = 0.015

const isShare = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** The box as `[x0, y0, x1, y1]`, or null when it is not a drawable box. */
function corners(region: readonly number[] | null | undefined): [number, number, number, number] | null {
  if (!region || region.length !== 4 || !region.every(isShare)) return null
  const [x, y, w, h] = region as [number, number, number, number]
  if (w <= 0 || h <= 0) return null
  return [x, y, Math.min(1, x + w), Math.min(1, y + h)]
}

/** A pointer as a small square box, so it is drawn and clipped like any other place. */
function pointBox(point: readonly number[] | null | undefined): [number, number, number, number] | null {
  if (!point || point.length !== 2 || !point.every(isShare)) return null
  const [x, y] = point as [number, number]
  return [Math.max(0, x - POINT_HALF), Math.max(0, y - POINT_HALF), Math.min(1, x + POINT_HALF), Math.min(1, y + POINT_HALF)]
}

/** The place's box on the PAGE as `[x0, y0, x1, y1]`; null for a whole page, or a box on an embedded image. */
export function placeBox(place: PagePlace): [number, number, number, number] | null {
  if (place.frame !== 'page') return null
  return corners(place.region) ?? pointBox(place.point)
}

/** The boxes the viewer marks on the page for this place: none for a whole page. */
export function placeRegions(place: PagePlace): PageRegion[] {
  const box = placeBox(place)
  if (!box) return []
  const label = place.label?.trim()
  return [{ box, ...(label ? { label } : {}) }]
}

function span(start: number, length: number, total: number): [number, number] {
  const size = Math.min(length, total)
  return [Math.min(Math.max(0, start), total - size), size]
}

/**
 * Which part of the page a thumbnail draws, in the page's own units: the box
 * with a margin, widened to {@link CLIP_ASPECT} where the page allows it, so a
 * tall narrow box still shows the drawing beside it. The whole page without a
 * box. `mark` is the box relative to the clip, for the marks drawn over it.
 */
export function placeClip(
  page: { width: number; height: number },
  box: readonly [number, number, number, number] | null
): { crop: Box; mark: Box | null } {
  const whole = { crop: { x: 0, y: 0, width: page.width, height: page.height }, mark: null }
  if (!box || page.width <= 0 || page.height <= 0) return whole
  const [x0, y0, x1, y1] = box
  const area = { x: x0 * page.width, y: y0 * page.height, width: (x1 - x0) * page.width, height: (y1 - y0) * page.height }
  if (area.width <= 0 || area.height <= 0) return whole

  const marginX = Math.max(area.width * BOX_MARGIN, page.width * PAGE_MARGIN)
  const marginY = Math.max(area.height * BOX_MARGIN, page.height * PAGE_MARGIN)
  let width = area.width + 2 * marginX
  let height = area.height + 2 * marginY
  if (width / height < CLIP_ASPECT) width = height * CLIP_ASPECT
  else height = width / CLIP_ASPECT
  const centreX = area.x + area.width / 2
  const centreY = area.y + area.height / 2
  const [x, w] = span(centreX - width / 2, width, page.width)
  const [y, h] = span(centreY - height / 2, height, page.height)
  return {
    crop: { x, y, width: w, height: h },
    mark: { x: area.x - x, y: area.y - y, width: area.width, height: area.height },
  }
}

/**
 * The same-origin URL pdf.js reads the place's page from, or null when there
 * is none: a stored document's stream (that Fassung's, when the place names
 * one), the corpus route for a Basiswissen file. Both are authorized like the
 * document itself; the reader who may not open it gets a 403 or 404 here.
 */
export function placeFileUrl(place: PagePlace): string | null {
  const { document, revisionId } = place
  if (document.shelf === 'base') return `/api/knowledge-base/documents/${encodeURIComponent(document.name)}`
  if (!document.id) return null
  const id = encodeURIComponent(document.id)
  return revisionId ? `/api/documents/${id}/file?versionId=${encodeURIComponent(revisionId)}` : `/api/documents/${id}/file`
}

/** The stored document's preview route, which signs a URL for an image upload. */
export function placePreviewUrl(place: PagePlace): string | null {
  if (place.document.shelf !== 'stored' || !place.document.id) return null
  return `/api/documents/${encodeURIComponent(place.document.id)}/preview`
}
