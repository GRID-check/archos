'use client'

/**
 * PageRegionThumbnail: a place on a document, small (ADR-0128). The clip of
 * the page around the box (or the whole page) with the box marked by the
 * viewer's own `RegionMarks`, so the thumbnail and the opened document agree.
 *
 * Shared by the look card, the Herleitung's look row and the citation peek.
 * Drawing is `drawPlace`: the document's own routes, pdf.js for a PDF, the
 * preview route's signed URL for an image upload, only the clip, at the size
 * it is shown. With `lazy` (the default) nothing is fetched until the
 * thumbnail comes on screen. A reader who may not open the document sees a
 * tile saying so and nothing of the page.
 */

import { useEffect, useRef, useState, type CSSProperties, type FC } from 'react'
import { FileX2, Lock } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useSeenOnce } from '@/hooks/use-seen-once'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { drawPlace, type DrawnPlace, type ImageClip } from '../lib/place-drawing'
import type { PagePlace } from '../lib/page-place'
import { PageSheet } from './pdf-viewer-atoms'
import { RegionMarks } from './region-marks'
import type { PageRegion } from '../lib/page-region'

/** Width drawn at when the frame has not been laid out (a test, a hidden tab). */
const FALLBACK_WIDTH = 288
/** The shape of the frame while nothing is drawn yet. */
const WAITING_ASPECT = 3 / 2

type State = { status: 'waiting' } | DrawnPlace

export interface PageRegionThumbnailProps {
  place: PagePlace
  /** Draw the part around the box (default) or the whole page with the box on it. */
  clip?: boolean
  /** Wait until on screen before fetching anything (default). */
  lazy?: boolean
  /** Width in CSS pixels; the frame's own width when unset. */
  width?: number
  /** The drawing is never taller than this, in CSS pixels. */
  maxHeight?: number
  /** CSS colour of the mark. */
  color?: string
  /** What the picture shows, for a screen reader; „Seite N“ when unset. */
  label?: string
  /** `none`: render nothing when the page cannot be shown, instead of a tile saying so. */
  fallback?: 'tile' | 'none'
  /** Told once the place is drawn: an image upload's signed picture, so a viewer can open it. */
  onDrawn?: (drawn: { image?: ImageClip }) => void
  /** Told when the reader may not open the document. */
  onDenied?: () => void
  /**
   * The boxes to mark, in the page's frame, instead of the place's own: a
   * citation with several depictions on one page. Only with `clip={false}`,
   * where the drawn part is the page.
   */
  marks?: readonly PageRegion[]
  className?: string
  /** Marker attributes for the outer element, e.g. `data-citation-thumbnail`. */
  [data: `data-${string}`]: string | undefined
}

const imageStyle = ({ crop }: ImageClip): CSSProperties => ({
  position: 'absolute',
  maxWidth: 'none',
  width: `${100 / crop.width}%`,
  height: `${100 / crop.height}%`,
  left: `${(-crop.x / crop.width) * 100}%`,
  top: `${(-crop.y / crop.height) * 100}%`,
})

export const PageRegionThumbnail: FC<PageRegionThumbnailProps> = ({
  place,
  clip = true,
  lazy = true,
  width,
  maxHeight,
  color,
  label,
  fallback = 'tile',
  onDrawn,
  onDenied,
  marks,
  className,
  ...data
}) => {
  const t = useTranslations('knowledge')
  const [seenRef, seen] = useSeenOnce<HTMLDivElement>()
  const frameRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [state, setState] = useState<State>({ status: 'waiting' })
  const near = !lazy || seen
  // The callbacks are read when the drawing ends, not a reason to draw again.
  const told = useRef({ onDrawn, onDenied })
  told.current = { onDrawn, onDenied }
  const regionKey = `${place.region?.join(',') ?? ''}|${place.point?.join(',') ?? ''}`

  useEffect(() => {
    const canvas = canvasRef.current
    if (!near || !canvas) return
    const controller = new AbortController()
    setState({ status: 'waiting' })
    void drawPlace({
      place,
      canvas,
      fit: { width: width ?? (frameRef.current?.clientWidth || FALLBACK_WIDTH), maxHeight },
      clip,
      signal: controller.signal,
    }).then((drawn) => {
      if (controller.signal.aborted) return
      setState(drawn)
      if (drawn.status === 'drawn') told.current.onDrawn?.({ image: drawn.image })
      if (drawn.status === 'denied') told.current.onDenied?.()
    })
    return () => controller.abort()
    // `place` is keyed by its address below; a new object for the same place draws nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    near,
    place.document.id,
    place.document.name,
    place.document.shelf,
    place.page,
    place.frame,
    place.revisionId,
    regionKey,
    clip,
    width,
    maxHeight,
  ])

  const name = label ?? t('placeThumbnail.page', { page: place.page })
  const setFrame = (node: HTMLDivElement | null): void => {
    frameRef.current = node
    seenRef(node)
  }

  if (state.status === 'unavailable' && fallback === 'none') return null
  if (state.status === 'denied' || state.status === 'unavailable') {
    const denied = state.status === 'denied'
    const Icon = denied ? Lock : FileX2
    return (
      <div
        ref={setFrame}
        {...data}
        data-place-thumbnail=""
        data-state={state.status}
        className={cn(
          'bg-muted/60 text-muted-foreground flex w-full flex-col items-center justify-center gap-1 rounded-sm p-3 text-center text-xs',
          className
        )}
        // At a given width the tile keeps the thumbnail's shape; at the column's width it stays a line high.
        style={width ? { width, aspectRatio: WAITING_ASPECT, maxHeight } : { minHeight: 72 }}
      >
        <Icon aria-hidden className="size-4" />
        <span>{t(denied ? 'placeThumbnail.noAccess' : 'placeThumbnail.unavailable')}</span>
      </div>
    )
  }

  const drawn = state.status === 'drawn' ? state : null
  const shown: readonly PageRegion[] = !drawn
    ? []
    : marks && !clip
      ? marks
      : drawn.mark
        ? [{ box: drawn.mark }]
        : []
  return (
    <div ref={setFrame} {...data} data-place-thumbnail="" data-state={state.status} className={cn('flex w-full justify-center', className)}>
      <PageSheet
        className="max-w-full overflow-hidden rounded-sm"
        style={{
          aspectRatio: drawn ? drawn.aspect : WAITING_ASPECT,
          width: drawn ? drawn.width : (width ?? '100%'),
          maxHeight: drawn ? undefined : maxHeight,
        }}
      >
        {drawn?.image && (
          // An image upload's signed picture, placed so only the clip shows.
          // oxlint-disable-next-line nextjs/no-img-element -- a signed object-store URL the optimizer cannot fetch
          <img src={drawn.image.url} alt={name} style={imageStyle(drawn.image)} />
        )}
        {/* Always mounted, so a redraw has its canvas; hidden while nothing is on it or the picture is an image. */}
        <canvas
          ref={canvasRef}
          role={drawn && !drawn.image ? 'img' : undefined}
          aria-label={drawn && !drawn.image ? name : undefined}
          aria-hidden={drawn && !drawn.image ? undefined : true}
          className={cn('block h-full w-full', (!drawn || drawn.image) && 'invisible absolute inset-0')}
        />
        {!drawn && (
          <Skeleton role="status" className="absolute inset-0 rounded-none" aria-label={t('placeThumbnail.loading')} />
        )}
        {shown.length > 0 && <RegionMarks regions={shown} color={color} />}
      </PageSheet>
    </div>
  )
}
