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

/**
 * One page of one Fassung, painted at the scale the whole comparison shares.
 *
 * The canvas is sized in CSS pixels from the natural size, so the layout does
 * not wait for the bitmap: the sheet's box is right the moment the size is
 * known and the picture fills it when the render lands. A new page, scale or
 * ink cancels the paint in flight first, because two paints into one canvas
 * interleave.
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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || scale <= 0) return
    let cancelled = false
    const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    const handle = source.render(page, canvas, { scale, pixelRatio })
    handle.promise
      .then(() => {
        if (!cancelled && ink) tintCanvas(canvas, ink)
      })
      .catch(() => {
        // A page that cannot be painted leaves its sheet blank; the other side
        // and the controls still work, and a reader can see the gap.
      })
    return () => {
      cancelled = true
      handle.cancel()
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
