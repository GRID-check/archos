/**
 * Draw a place on a document small (ADR-0128): the clip of the page around the
 * box, or the whole page, with the box's position in the drawn part so the
 * caller can mark it with the viewer's own `RegionMarks`.
 *
 * A PDF (a stored one, its Fassung, an office file's rendition, or a corpus
 * file) is drawn with the viewer's pdf.js runtime from the same-origin route
 * the viewer reads, and only the clip is rasterized, at the size it is shown.
 * A stored image upload has no PDF stream (`/file` answers 415), so its
 * picture comes from the document's preview route, which signs a URL for it.
 * Both routes authorize exactly as opening the document does: a reader who
 * may not open it gets a 403 or a 404, and the caller shows the place without
 * a picture. Nothing is stored and no `data:` URL is made.
 */

import type { PageRegion } from './page-region'
import { maxCanvasPixels, rasterFor, type Box } from './pdf-raster'
import { placeBox, placeClip, placeFileUrl, placePreviewUrl, type PagePlace } from './page-place'
import { documentParameters, loadPdfjs } from './pdfjs-runtime'

/** The size the drawing must fit: its width, and at most this height. */
export interface PlaceFit {
  width: number
  maxHeight?: number
}

/** Where an image upload's clip sits, as shares of the image; percentages for the `<img>` that shows it. */
export interface ImageClip {
  url: string
  crop: Box
}

export type DrawnPlace =
  | {
      status: 'drawn'
      /** Drawn width in CSS pixels. */
      width: number
      /** Width over height of the drawn part. */
      aspect: number
      /** The place's box within the drawn part, `[x0, y0, x1, y1]`; null when nothing is marked. */
      mark: PageRegion['box'] | null
      /** Set for an image upload: the caller shows it as an `<img>` instead of the canvas. */
      image?: ImageClip
    }
  | { status: 'denied' }
  | { status: 'unavailable' }

const UNAVAILABLE: DrawnPlace = { status: 'unavailable' }
const DENIED: DrawnPlace = { status: 'denied' }

/** The HTTP status of a failed pdf.js open (`ResponseException`), when it has one. */
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

const deniedStatus = (status: number | undefined): boolean => status === 401 || status === 403 || status === 404

/** Fit `aspect` into the box: the width, unless that would be taller than `maxHeight`. */
const fittedWidth = (fit: PlaceFit, aspect: number): number =>
  Math.max(1, Math.round(fit.maxHeight ? Math.min(fit.width, fit.maxHeight * aspect) : fit.width))

/**
 * What to draw and where the place's box sits in it: with `clip`, the part
 * around the box; without, the whole page with the box still marked. A box on
 * an embedded image is never marked on the page.
 */
function clipFor(
  size: { width: number; height: number },
  place: PagePlace,
  clip: boolean
): { crop: Box; mark: PageRegion['box'] | null } {
  const box = placeBox(place)
  const { crop } = placeClip(size, clip ? box : null)
  if (!box) return { crop, mark: null }
  const [x0, y0, x1, y1] = box
  const left = (x0 * size.width - crop.x) / crop.width
  const top = (y0 * size.height - crop.y) / crop.height
  const right = (x1 * size.width - crop.x) / crop.width
  const bottom = (y1 * size.height - crop.y) / crop.height
  return { crop, mark: [left, top, right, bottom] }
}

async function drawImage(place: PagePlace, fit: PlaceFit, clip: boolean, signal: AbortSignal): Promise<DrawnPlace> {
  const previewUrl = placePreviewUrl(place)
  if (!previewUrl) return UNAVAILABLE
  const response = await fetch(previewUrl, { signal })
  if (deniedStatus(response.status)) return DENIED
  if (!response.ok) return UNAVAILABLE
  const body = (await response.json()) as { url?: unknown; imageUrl?: unknown; contentType?: unknown }
  const url = typeof body.imageUrl === 'string' ? body.imageUrl : typeof body.url === 'string' ? body.url : null
  if (!url || typeof body.contentType !== 'string' || !body.contentType.startsWith('image/')) return UNAVAILABLE

  const natural = await new Promise<{ width: number; height: number } | null>((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve(null)
    image.src = url
  })
  if (!natural || natural.width <= 0 || natural.height <= 0 || signal.aborted) return UNAVAILABLE
  const { crop, mark } = clipFor(natural, place, clip)
  const aspect = crop.width / crop.height
  return {
    status: 'drawn',
    width: fittedWidth(fit, aspect),
    aspect,
    mark,
    image: {
      url,
      crop: {
        x: crop.x / natural.width,
        y: crop.y / natural.height,
        width: crop.width / natural.width,
        height: crop.height / natural.height,
      },
    },
  }
}

/**
 * Draw `place` into `canvas` to fit `fit`. With `clip`, the part around its
 * box; without, or for a place with no box on the page, the whole page.
 * Never rejects.
 *
 * Each call opens its own pdf.js document. The file routes it reads
 * (`/api/documents/{id}/file`, `…/versions/{versionId}/file`) answer the whole
 * file and no `Range` (no `Accept-Ranges`, no `Content-Length`), so pdf.js
 * reads the whole file rather than the pages it needs. Their
 * `Cache-Control: private, max-age=300` lets the browser reuse the bytes for a
 * card's later thumbnails of the same file, not for ones fetched at once.
 * Range support waits on the download log: an own-list document's every range
 * request would be one access row (`recordDocumentAccess`).
 */
export async function drawPlace(options: {
  place: PagePlace
  canvas: HTMLCanvasElement
  fit: PlaceFit
  clip?: boolean
  signal: AbortSignal
}): Promise<DrawnPlace> {
  const { place, canvas, fit, clip = true, signal } = options
  const url = placeFileUrl(place)
  if (!url) return UNAVAILABLE
  let loading: { promise: Promise<unknown>; destroy: () => Promise<void> } | null = null
  try {
    const pdfjs = await loadPdfjs()
    if (signal.aborted) return UNAVAILABLE
    const task = pdfjs.getDocument(documentParameters(url))
    loading = task
    let doc: Awaited<typeof task.promise>
    try {
      doc = await task.promise
    } catch (error) {
      const status = statusOf(error)
      if (status === 415 && place.document.shelf === 'stored') return await drawImage(place, fit, clip, signal)
      return deniedStatus(status) ? DENIED : UNAVAILABLE
    }
    if (signal.aborted || place.page < 1 || place.page > doc.numPages) return UNAVAILABLE
    const page = await doc.getPage(place.page)
    const base = page.getViewport({ scale: 1 })
    const { crop, mark } = clipFor(base, place, clip)
    const aspect = crop.width / crop.height
    const width = fittedWidth(fit, aspect)
    const scale = width / crop.width
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
    const raster = rasterFor({
      width,
      height: crop.height * scale,
      dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
      maxPixels: maxCanvasPixels(coarse),
    })
    const pixels = scale * raster.ratio
    const viewport = page.getViewport({ scale: pixels, offsetX: -crop.x * pixels, offsetY: -crop.y * pixels })
    canvas.width = raster.width
    canvas.height = raster.height
    const render = page.render({ canvas, viewport })
    signal.addEventListener('abort', () => render.cancel(), { once: true })
    await render.promise
    return signal.aborted ? UNAVAILABLE : { status: 'drawn', width, aspect, mark }
  } catch {
    return UNAVAILABLE
  } finally {
    void loading?.destroy()
  }
}
