'use client'

/**
 * The page rail: every page of the document, small, down the stage's left
 * edge, with the one the reader is on marked.
 *
 * It answers the two questions a page counter cannot: what the document LOOKS
 * like (a plan set is a cover, three Grundrisse and two Schnitte, and you find
 * the Schnitt by its shape, not its number) and where in it you are. Only where
 * there is room for it: the caller hides it in a narrow container, so the chat
 * peek never pays for it, and a hidden rail rasterises nothing because its
 * thumbnails never intersect anything.
 *
 * Thumbnails rasterise lazily, as the pages do, and drop their bitmaps once
 * they scroll well out of the rail: two hundred thumbnails at device resolution
 * are tens of megabytes nobody is looking at.
 */

import { useEffect, useRef, useState, type FC, type RefObject } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useTranslations } from '@/i18n'
import { knowledgeCopy } from '@/i18n/namespaces/knowledge'
import { cn } from '@/lib/utils'
import { PageSheet, PageThumbnailButton } from './pdf-viewer-atoms'

/** Drawn width of a thumbnail's sheet, in CSS pixels. */
const THUMB_WIDTH = 84
const MAX_PIXEL_RATIO = 2
const PRERENDER_MARGIN = '200% 0px'

export interface PdfThumbnailRailProps {
  doc: PDFDocumentProxy
  pages: readonly number[]
  currentPage: number
  /** Page 1's height over its width, until a thumbnail knows its own. */
  defaultAspect: number | null
  onSelect: (page: number) => void
  className?: string
}

export const PdfThumbnailRail: FC<PdfThumbnailRailProps> = ({
  doc,
  pages,
  currentPage,
  defaultAspect,
  onSelect,
  className,
}) => {
  const t = useTranslations(knowledgeCopy)
  const railRef = useRef<HTMLElement | null>(null)

  // Keep the current page's thumbnail in view while the reader scrolls the
  // document, without dragging the rail when it is already visible.
  useEffect(() => {
    const rail = railRef.current
    const node = rail?.querySelector<HTMLElement>(`[data-thumb="${currentPage}"]`)
    if (!rail || !node) return
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    if (top < rail.scrollTop || bottom > rail.scrollTop + rail.clientHeight) {
      rail.scrollTo({ top: top - rail.clientHeight / 2 + node.offsetHeight / 2 })
    }
  }, [currentPage])

  return (
    <nav
      ref={railRef}
      aria-label={t('viewer.pages')}
      data-testid="pdf-thumbnail-rail"
      className={cn(
        'scrollbar-hide relative flex w-28 shrink-0 flex-col gap-1 overflow-y-auto overscroll-contain border-r border-border px-2 pt-3 pb-16',
        className,
      )}
    >
      {pages.map((number) => (
        <PageThumbnailButton
          key={number}
          data-thumb={number}
          number={number}
          current={number === currentPage}
          aria-label={t('viewer.pageLabel', { page: number })}
          onClick={() => onSelect(number)}
        >
          <Thumbnail doc={doc} pageNumber={number} defaultAspect={defaultAspect} railRef={railRef} />
        </PageThumbnailButton>
      ))}
    </nav>
  )
}

const Thumbnail: FC<{
  doc: PDFDocumentProxy
  pageNumber: number
  defaultAspect: number | null
  railRef: RefObject<HTMLElement | null>
}> = ({ doc, pageNumber, defaultAspect, railRef }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  const [aspect, setAspect] = useState<number | null>(null)

  useEffect(() => {
    const node = sheetRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setNear(entry.isIntersecting)
      },
      { root: railRef.current, rootMargin: PRERENDER_MARGIN },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [railRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!near) {
      canvas.width = 0
      canvas.height = 0
      return
    }
    let cancelled = false
    let cancelRender: (() => void) | null = null
    const run = async (): Promise<void> => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const base = page.getViewport({ scale: 1 })
      setAspect(base.height / base.width)
      const ratio = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
      const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * ratio })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const task = page.render({ canvas, viewport })
      cancelRender = () => task.cancel()
      await task.promise.catch(() => {})
    }
    void run().catch(() => {})
    return () => {
      cancelled = true
      cancelRender?.()
    }
  }, [doc, pageNumber, near])

  const effective = aspect ?? defaultAspect ?? Math.SQRT2
  return (
    <PageSheet ref={sheetRef} className="mx-auto" style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * effective }}>
      <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />
    </PageSheet>
  )
}
