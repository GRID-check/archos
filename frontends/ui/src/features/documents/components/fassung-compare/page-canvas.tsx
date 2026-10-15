'use client'

import type { CSSProperties, JSX } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { PageSize, PageSource } from './types'
import { tintCanvas, type Rgb } from './lib/tint'

export interface PageCanvasProps {
  source: PageSource
  /** 1-based. */
  page: number
  /** The page's natural size, from `source.pageSize`. */
  size: PageSize
  /** CSS pixels per natural unit. */
  scale: number
  /** Recolour the page's dark lines in this ink (the overlay); unset draws it as it is. */
  ink?: Rgb
  label: string
  className?: string
  style?: CSSProperties
}

/** How long a new scale waits before the page is painted again: a pinch paints once, not every frame. */
const REPAINT_DELAY_MS = 140

/**
 * One page of one Fassung, painted at the scale the whole comparison shares.
 *
 * The canvas is sized in CSS pixels from the natural size, so the layout does
 * not wait for the bitmap: the sheet's box is right the moment the size is
 * known and the picture fills it when the render lands.
 *
 * A repaint goes into a scratch canvas and is copied over in one step. Painting
 * into the canvas on screen cleared it the moment its size was set, so every
 * step of a pinch blanked the sheet until pdf.js had drawn it again. While the
 * scale moves, the old picture is stretched; a beat after it rests, the sharp
 * one replaces it. A new page or ink paints at once.
 */
export function PageCanvas({
  source,
  page,
  size,
  scale,
  ink,
  label,
  className,
  style,
}: PageCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const paintedRef = useRef<{ source: PageSource; page: number; ink?: Rgb } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || scale <= 0) return
    let cancelled = false
    let handle: { cancel: () => void } | null = null
    const scratch = document.createElement('canvas')
    const paint = (): void => {
      const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
      const render = source.render(page, scratch, { scale, pixelRatio })
      handle = render
      render.promise
        .then(() => {
          if (cancelled || scratch.width === 0) return
          if (ink) tintCanvas(scratch, ink)
          canvas.width = scratch.width
          canvas.height = scratch.height
          canvas.getContext('2d')?.drawImage(scratch, 0, 0)
          paintedRef.current = { source, page, ink }
        })
        .catch(() => {
          // A page that cannot be painted leaves its sheet blank; the other side
          // and the controls still work, and a reader can see the gap.
        })
        .finally(() => {
          // iOS frees a canvas's memory when its size goes to zero.
          scratch.width = 0
          scratch.height = 0
        })
    }
    const painted = paintedRef.current
    const sameDrawing = painted?.source === source && painted.page === page && painted.ink === ink && canvas.width > 0
    const timer = sameDrawing ? window.setTimeout(paint, REPAINT_DELAY_MS) : null
    if (!sameDrawing) paint()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      handle?.cancel()
    }
  }, [source, page, scale, ink])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      data-testid="compare-page"
      className={cn('block max-w-none', className)}
      style={{ width: size.width * scale, height: size.height * scale, ...style }}
    />
  )
}
