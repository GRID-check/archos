/**
 * Opens a stored document as something the comparison can draw.
 *
 * It reuses what the preview already trusts: pdf.js through the one runtime
 * loader (`pdfjs-runtime`, assets staged in `public/pdfjs`), the same-origin
 * `/api/documents/{id}/file` stream for PDFs and for the PDF rendition of an
 * office file (ADR-0070), and the preview route's presigned URL for images,
 * which `/file` refuses by design (an SVG served inline from this origin is
 * stored XSS).
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'
import { documentFileUrl } from '@/lib/documents/urls'
import { documentParameters, loadPdfjs } from '@/features/knowledge/lib/pdfjs-runtime'
import { maxCanvasPixels, rasterFor, type Raster } from '@/features/knowledge/lib/pdf-raster'
import {
  NotComparableError,
  type CompareFile,
  type PageSize,
  type PageSource,
  type RenderHandle,
} from '../types'
import { compareKindOf } from './compare-kind'

/**
 * The bitmap a page gets at `scale`: device resolution, held to the canvas
 * budget (`pdf-raster.ts`). Two pages are on screen at once in every view, and
 * iOS draws NOTHING for a canvas past its limit: an A1 sheet at 6x on a DPR 3
 * phone was blank, not soft.
 */
export function pageRaster(size: PageSize, scale: number, pixelRatio: number): Raster {
  const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  return rasterFor({
    width: size.width * scale,
    height: size.height * scale,
    dpr: pixelRatio,
    maxPixels: maxCanvasPixels(coarse),
  })
}

const sizeCanvas = (canvas: HTMLCanvasElement, raster: Raster): void => {
  canvas.width = raster.width
  canvas.height = raster.height
}

async function openPdf(file: CompareFile, isRendition: boolean): Promise<PageSource> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument(documentParameters(documentFileUrl(file.id)))
  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (error) {
    void task.destroy()
    // The BFF answers an office file it cannot convert with 415 or 502: nothing
    // a retry fixes, and not a fault of the viewer either.
    if (isRendition) throw new NotComparableError()
    throw error
  }
  return {
    pageCount: doc.numPages,
    pageSize: async (page) => {
      const view = (await doc.getPage(page)).getViewport({ scale: 1 })
      return { width: view.width, height: view.height }
    },
    render: (page, canvas, { scale, pixelRatio }): RenderHandle => {
      let cancel = (): void => {}
      const promise = doc.getPage(page).then(async (pdfPage) => {
        const unscaled = pdfPage.getViewport({ scale: 1 })
        const raster = pageRaster({ width: unscaled.width, height: unscaled.height }, scale, pixelRatio)
        const viewport = pdfPage.getViewport({ scale: scale * raster.ratio })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        const render = pdfPage.render({ canvas, viewport })
        cancel = () => render.cancel()
        // A cancelled render rejects; that is the teardown path, not a failure.
        await render.promise.catch(() => {})
      })
      return { promise, cancel: () => cancel() }
    },
    destroy: () => {
      void task.destroy()
    },
  }
}

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image failed to load'))
    image.src = url
  })

async function openImage(file: CompareFile): Promise<PageSource> {
  const response = await fetch(`/api/documents/${encodeURIComponent(file.id)}/preview`)
  if (!response.ok) throw new Error(`preview ${response.status}`)
  const body: unknown = await response.json()
  const url = typeof body === 'object' && body !== null ? (body as { url?: unknown }).url : null
  if (typeof url !== 'string') throw new Error('preview carried no url')
  const image = await loadImage(url)
  const size: PageSize = {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  }
  return {
    pageCount: 1,
    pageSize: async () => size,
    render: (_page, canvas, { scale, pixelRatio }): RenderHandle => {
      sizeCanvas(canvas, pageRaster(size, scale, pixelRatio))
      const context = canvas.getContext('2d')
      if (context) {
        // Paper first: a transparent PNG would otherwise take the whole ink in
        // the overlay's recolouring.
        context.fillStyle = '#fff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
      }
      return { promise: Promise.resolve(), cancel: () => {} }
    },
    destroy: () => {},
  }
}

/** The default {@link SourceLoader}: PDF, office rendition or image, by file name. */
export async function openPageSource(file: CompareFile): Promise<PageSource> {
  const kind = compareKindOf(file.filename)
  if (kind === 'pdf') return openPdf(file, false)
  if (kind === 'office') return openPdf(file, true)
  if (kind === 'image') return openImage(file)
  throw new NotComparableError()
}
