import { useEffect, useRef, useState, type CSSProperties, type FC, type ReactNode } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'

import { cn } from '@/lib/utils'

import { readPageTextItems, renderTextLayer, type TextLayerHandle } from '../lib/pdfjs-runtime'
import { pageTextChunks } from '../lib/pdf-text-chunks'
import { canvasMeasure } from '../lib/canvas-measure'
import type { PageRegion } from '../lib/page-region'
import { RegionMarks } from './region-marks'
import { locatePassage, type HighlightRect } from '../lib/passage-highlight'

import { detailCovers, detailPlan, rasterFor, sameRaster, visiblePart, type Box } from '../lib/pdf-raster'

import { PageSheet } from './pdf-viewer-atoms'

import { PRERENDER_MARGIN, PassageHit, RERASTER_DELAY_MS, ViewSignal, canvasBudget, screenRatio } from './pdf-document-view-helpers'

interface PdfPageCanvasProps {
  doc: PDFDocumentProxy
  pageNumber: number
  /** "Page 3", for assistive technology moving through the pages. */
  label: string
  targetWidth: number
  /** Page 1's aspect, so an unrendered page still reserves the right height. */
  defaultAspect: number | null
  highlight?: string | null
  highlightColor?: string
  marks: HighlightRect[] | null
  /** The reader's own search hits on this page; `active` is the one on screen. */
  searchMarks: Array<{ rects: HighlightRect[]; active: boolean }> | null
  /** The cited region's boxes, when this is the page they were stated for. */
  regions: readonly PageRegion[] | null
  /** The caller's own marks on this page (see `PdfDocumentViewProps.pageOverlay`). */
  overlay?: ReactNode
  /** The marks are a guess — see {@link PassageHit.fuzzy}. */
  fuzzy: boolean
  ping: number
  onPassage: (hit: PassageHit) => void
  /** This page read its text and the passage is not on it. */
  onMiss: (page: number) => void
  /** The page's unscaled width, once known. */
  onBase: (page: number, width: number) => void
  registerRef: (page: number, node: HTMLDivElement | null) => void
  /** The viewer's scroll frame: what "on screen" is measured against. */
  frameRef: { readonly current: HTMLElement | null }
  /** Fires when the view comes to rest: the moment to draw a sharp detail. */
  viewSignal: ViewSignal
  /** Whether the stack is mid-gesture or settling; nothing is measured then. */
  moving: { readonly active: boolean }
}

/**
 * One page: a canvas sized to the frame, rasterised while near the viewport,
 * with the passage marks laid over it in the page's own coordinate space.
 *
 * The page's SIZE follows the zoom at once and its BITMAP follows a beat later:
 * the canvas is stretched by CSS to the new size while a pinch is still moving,
 * and re-drawn sharp once it stops. Re-rasterising on every frame of a pinch is
 * a full render per page per frame, and the pinch stutters.
 */
export const PdfPageCanvas: FC<PdfPageCanvasProps> = ({
  doc,
  pageNumber,
  label,
  targetWidth,
  defaultAspect,
  highlight,
  highlightColor,
  marks,
  searchMarks,
  regions,
  overlay,
  fuzzy,
  ping,
  onPassage,
  onMiss,
  onBase,
  registerRef,
  frameRef,
  viewSignal,
  moving,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Where the sharp detail canvas is hung, and what the one on show covers.
  const detailHostRef = useRef<HTMLDivElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  // The page proxy currently held open, so eviction can release its caches.
  const openedPage = useRef<PDFPageProxy | null>(null)
  // The page's unscaled size, learned once and kept through eviction, so a
  // page that has been seen keeps reserving the right room and every scale is
  // arithmetic rather than a round trip to pdf.js.
  const [base, setBase] = useState<{ width: number; height: number } | null>(null)
  const scale = base && targetWidth > 0 ? targetWidth / base.width : 1

  useEffect(() => {
    if (base) onBase(pageNumber, base.width)
  }, [base, pageNumber, onBase])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setNear(entry.isIntersecting)
      },
      { rootMargin: PRERENDER_MARGIN },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  /**
   * Rasterise. Keyed on the zoom-driven `targetWidth`, because that is the only
   * thing that changes what the bitmap should look like.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!near || targetWidth <= 0) {
      // Release the bitmap AND the page's own caches for a page that scrolled
      // out of the band. Zeroing the canvas alone leaves pdf.js holding the
      // page's operator list and text content, which for a long document is the
      // larger half of what the eviction band exists to bound. The sheet keeps
      // its height, so nothing moves under the reader.
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      const opened = openedPage.current
      openedPage.current = null
      opened?.cleanup()
      return
    }

    let cancelled = false
    let cancelRender: (() => void) | null = null

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      openedPage.current = pdfPage
      const unscaled = pdfPage.getViewport({ scale: 1 })
      setBase((current) =>
        current && current.width === unscaled.width && current.height === unscaled.height
          ? current
          : { width: unscaled.width, height: unscaled.height },
      )
      if (!canvas) return

      // Rasterise at device resolution and let CSS size it back down, or the
      // page is soft on exactly the retina screens people read plans on — but
      // never past the canvas budget: iOS draws NOTHING for a canvas over its
      // limit, so a deep zoom on an A1 sheet used to go blank. Past the budget
      // the base is softer and the detail canvas below draws the part on
      // screen sharp. A capped base keeps its pixel count as the zoom grows,
      // so it is not re-drawn for a zoom it would look the same at.
      const raster = rasterFor({
        width: targetWidth,
        height: (targetWidth * unscaled.height) / unscaled.width,
        dpr: screenRatio(),
        maxPixels: canvasBudget(),
      })
      if (canvas.width > 0 && sameRaster(canvas, raster)) return
      const viewport = pdfPage.getViewport({ scale: (targetWidth / unscaled.width) * raster.ratio })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const task = pdfPage.render({ canvas, viewport })
      cancelRender = () => task.cancel()
      await task.promise.catch(() => {})
    }

    // A page that cannot be drawn must not take the dialog down with it — the
    // other pages, and the document, are still worth reading. The reason still
    // has to be reachable, or "one blank page" is an unfalsifiable bug report.
    const start = (): void => {
      void run().catch((error: unknown) => {
        if (process.env.NODE_ENV === 'development') {
          console.debug(`[pdf] page ${pageNumber} failed to render`, error)
        }
      })
    }
    // A page with a bitmap already is being zoomed: keep stretching the old
    // bitmap until the zoom settles. A blank page draws at once.
    const hasBitmap = Boolean(canvas && canvas.width > 0)
    const timer = hasBitmap ? window.setTimeout(start, RERASTER_DELAY_MS) : null
    if (!hasBitmap) start()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      cancelRender?.()
    }
  }, [doc, pageNumber, targetWidth, near])

  /**
   * The sharp detail: the part of the page on screen, drawn at device
   * resolution into a canvas of its own, whenever the base is softer than the
   * screen (`detailPlan`). Hung in PERCENT of the page, so through the next
   * zoom it stays where it belongs, stretched, until the view rests again and
   * a new one replaces it. Asked for only when the view rests (`viewSignal`),
   * never per scroll frame; kept while the screen stays inside its margin.
   */
  useEffect(() => {
    const host = detailHostRef.current
    if (!host) return
    let drawn: { region: Box; pageWidth: number } | null = null
    const drop = (): void => {
      for (const child of Array.from(host.children)) {
        if (child instanceof HTMLCanvasElement) {
          // Zeroed, not just removed: iOS frees a canvas's memory when its
          // size goes to zero, and only lazily when it is collected.
          child.width = 0
          child.height = 0
        }
      }
      host.replaceChildren()
      drawn = null
    }
    if (!near || targetWidth <= 0 || !base) {
      drop()
      return
    }
    let cancelled = false
    let task: RenderTask | null = null
    let pending: HTMLCanvasElement | null = null
    const pageHeight = (targetWidth * base.height) / base.width

    const update = (): void => {
      const node = containerRef.current
      const frameNode = frameRef.current
      if (cancelled || !node || !frameNode || moving.active) return
      const pageBox = node.getBoundingClientRect()
      const frameBox = frameNode.getBoundingClientRect()
      const visible = visiblePart(
        { x: pageBox.left, y: pageBox.top, width: pageBox.width, height: pageBox.height },
        { x: frameBox.left, y: frameBox.top, width: frameNode.clientWidth, height: frameNode.clientHeight },
      )
      const dpr = screenRatio()
      const maxPixels = canvasBudget()
      const plan = detailPlan({
        page: { width: targetWidth, height: pageHeight },
        // In layout pixels: the box is measured on screen, the page laid out
        // at `targetWidth`; the two agree whenever nothing is transformed.
        visible,
        base: rasterFor({ width: targetWidth, height: pageHeight, dpr, maxPixels }),
        dpr,
        maxPixels,
      })
      if (!plan) {
        task?.cancel()
        drop()
        return
      }
      if (drawn && detailCovers({ drawn: drawn.region, drawnWidth: drawn.pageWidth, pageWidth: targetWidth, visible })) return
      task?.cancel()
      if (pending) {
        pending.width = 0
        pending.height = 0
      }
      const { region, raster } = plan
      const canvas = document.createElement('canvas')
      pending = canvas
      canvas.width = raster.width
      canvas.height = raster.height
      canvas.setAttribute('aria-hidden', 'true')
      canvas.dataset.testid = 'pdf-page-detail'
      Object.assign(canvas.style, {
        position: 'absolute',
        left: `${(region.x / targetWidth) * 100}%`,
        top: `${(region.y / pageHeight) * 100}%`,
        width: `${(region.width / targetWidth) * 100}%`,
        height: `${(region.height / pageHeight) * 100}%`,
      })
      void doc
        .getPage(pageNumber)
        .then(async (pdfPage) => {
          if (cancelled || pending !== canvas) return
          const viewport = pdfPage.getViewport({
            scale: (targetWidth / base.width) * raster.ratio,
            offsetX: -region.x * raster.ratio,
            offsetY: -region.y * raster.ratio,
          })
          const started = typeof performance === 'undefined' ? 0 : performance.now()
          task = pdfPage.render({ canvas, viewport })
          await task.promise
          if (cancelled || pending !== canvas) return
          pending = null
          drop()
          host.appendChild(canvas)
          drawn = { region, pageWidth: targetWidth }
          if (process.env.NODE_ENV === 'development') {
            const elapsed = typeof performance === 'undefined' ? 0 : performance.now() - started
            console.debug(
              `[pdf] page ${pageNumber} detail ${raster.width}x${raster.height} (${(
                (raster.width * raster.height) /
                1e6
              ).toFixed(1)} MP) in ${Math.round(elapsed)} ms`,
            )
          }
        })
        .catch(() => {
          // A cancelled render rejects; that is a newer view taking over.
          if (pending === canvas) pending = null
          canvas.width = 0
          canvas.height = 0
        })
    }

    const unsubscribe = viewSignal.subscribe(update)
    return () => {
      cancelled = true
      unsubscribe()
      task?.cancel()
      if (pending) {
        pending.width = 0
        pending.height = 0
      }
    }
  }, [doc, pageNumber, near, targetWidth, base, frameRef, viewSignal, moving])

  /**
   * Find the cited passage. Deliberately NOT keyed on `targetWidth`.
   *
   * Matching once produced the rectangles for good: they are in unscaled page
   * space, and the overlay multiplies them by the current scale. Re-running on
   * every zoom step would re-announce the hit, so each click of the zoom
   * control would drag a reader who had deliberately scrolled to page 30 back
   * to the citation and replay the arrival pulse at them.
   */
  useEffect(() => {
    if (!near || !highlight) return
    let cancelled = false

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      const unscaled = pdfPage.getViewport({ scale: 1 })
      const items = await readPageTextItems(pdfPage)
      if (cancelled) return
      const match = locatePassage(pageTextChunks(items, unscaled.transform), highlight, canvasMeasure())
      if (cancelled) return
      if (match)
        onPassage({
          page: pageNumber,
          rects: match.rects,
          fuzzy: match.matcher !== 'exact' && match.matcher !== 'anchored',
        })
      // Saying "not here" is what lets the viewer look next door. A page that
      // stayed silent is indistinguishable from one still reading its text.
      else onMiss(pageNumber)
    }

    // A page with no readable text layer — a scan — is a supported outcome, not
    // an error: the viewer simply opens at the page with nothing marked.
    void run().catch((error: unknown) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[pdf] page ${pageNumber} passage lookup failed`, error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [doc, pageNumber, near, highlight, onPassage, onMiss])

  /**
   * Lay the page's own text over the bitmap while the page is in the band.
   *
   * Keyed on neither zoom nor the passage: pdf.js positions every run as a
   * percentage of the page box and sizes it from `--total-scale-factor`, so
   * zooming is a CSS variable rather than a re-read, and the selection the
   * reader had survives it. It is also what a screen reader reads: the canvas
   * is a picture, the layer is the page's words in reading order.
   */
  useEffect(() => {
    const container = textLayerRef.current
    if (!near || !container) return
    let cancelled = false
    let layer: TextLayerHandle | null = null

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      layer = await renderTextLayer(pdfPage, container)
      // Torn down mid-render: the handle arrived after the cleanup ran, so it
      // is this branch's job to release it or the runs stay over the canvas.
      if (cancelled) layer.destroy()
    }

    // A page whose text cannot be laid out still renders and can still be read;
    // only selecting on it is lost, and taking the viewer down would lose both.
    void run().catch((error: unknown) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[pdf] page ${pageNumber} text layer failed`, error)
      }
    })
    return () => {
      cancelled = true
      layer?.destroy()
    }
  }, [doc, pageNumber, near])

  // Its own measured shape once it has rendered; page 1's until then.
  const effectiveAspect = base ? base.height / base.width : defaultAspect
  const height = effectiveAspect && targetWidth ? targetWidth * effectiveAspect : undefined

  return (
    <PageSheet
      ref={(node) => {
        containerRef.current = node
        registerRef(pageNumber, node)
      }}
      data-page={pageNumber}
      role="group"
      aria-label={label}
      style={{ width: targetWidth || undefined, height }}
    >
      <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />
      {/* The sharp part, over the base it sharpens and under the text layer,
          so a selection and the marks still sit on top of it. */}
      <div ref={detailHostRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" />
      {/* The page's text, transparent and positioned over its own glyphs. It
          carries no pixels — its whole job is that a drag selects the sentence,
          Cmd-C copies it, a screen reader reads it and the search finds it,
          which a canvas alone silently refuses. `--total-scale-factor` is the
          zoom: pdf.js writes the runs in page units and multiplies by this, so
          the layer re-scales without being rebuilt. */}
      <div
        ref={textLayerRef}
        data-testid="pdf-text-layer"
        className="pdf-text-layer"
        style={{ ['--total-scale-factor' as string]: scale } as CSSProperties}
      />
      {regions && <RegionMarks regions={regions} color={highlightColor} ping={ping} />}
      {overlay && <div className="pointer-events-none absolute inset-0 z-20">{overlay}</div>}
      {searchMarks?.flatMap((entry, entryIndex) =>
        entry.rects.map((rect, index) => (
          <span
            key={`search-${entryIndex}-${index}`}
            data-testid="search-mark"
            data-active={entry.active || undefined}
            aria-hidden
            className={cn('pdf-search-hit pointer-events-none absolute', entry.active && 'pdf-search-hit--active')}
            style={{
              left: rect.x * scale,
              top: rect.y * scale,
              width: rect.width * scale,
              height: rect.height * scale,
            }}
          />
        )),
      )}
      {marks?.map((rect, index) => (
        <span
          // Remounting on each ping is what replays the arrival animation.
          key={`${ping}-${index}`}
          data-testid="passage-mark"
          data-fuzzy={fuzzy || undefined}
          aria-hidden
          className={cn(
            'passage-highlight animate-passage-ping motion-reduce:animate-none pointer-events-none absolute',
            fuzzy && 'passage-highlight--fuzzy'
          )}
          style={
            {
              left: rect.x * scale,
              top: rect.y * scale,
              width: rect.width * scale,
              height: rect.height * scale,
              ...(highlightColor ? { ['--passage-tint' as string]: highlightColor } : {}),
            } as CSSProperties
          }
        />
      ))}
    </PageSheet>
  )
}
