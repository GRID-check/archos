'use client'

/**
 * The drawing area of the comparison, one component per view, plus what it
 * says while it cannot draw.
 *
 * Every scroll frame carries `data-compare-frame`: the gestures
 * (`use-stage-gestures.ts`) and „show this change" both find the frame from the
 * element they start at, so neither cares which view is on.
 */

import type { CSSProperties, JSX, ReactNode } from 'react'
import { useRef } from 'react'
import { AlertTriangle, FileX2, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { cn } from '@/lib/utils'
import { PaneCaption, PaperSheet, SheetTag } from './compare-atoms'
import { PageCanvas } from './page-canvas'
import { RegionBoxes } from './region-boxes'
import { SwipeDivider } from './swipe-divider'
import { distinguishingTailLength } from '@/lib/text/middle-truncate'
import { hasPage } from './lib/pages'
import type { NumberedRegion } from './lib/regions'
import { NEWER_INK, OLDER_INK } from './lib/tint'
import type { ActiveRegion } from './use-active-region'
import type { SideState } from './use-page-sources'
import type { CompareFile, CompareMode, PageSize, PageSource } from './types'

/** One Fassung's drawing context: its source and the page it would show. */
export interface Side {
  file: CompareFile
  source: PageSource | null
  size: PageSize | null
}

export interface StageProps {
  mode: CompareMode
  sides: { older: Side; newer: Side }
  page: number
  stage: PageSize | null
  scale: number
  opacity: number
  divider: number
  onDividerChange: (value: number) => void
  regions: NumberedRegion[]
  activeRegion: ActiveRegion
  /** Past the fit, a frame has something to pan, and says so with its cursor. */
  pannable: boolean
}

/** A frame one finger scrolls and two fingers zoom (the gestures hook takes the pinch). */
const FRAME_CLASS = 'bg-surface-sunken flex min-h-0 overflow-auto p-4 touch-pan-x touch-pan-y'
const PAN_CLASS = 'cursor-grab data-[panning=true]:cursor-grabbing data-[panning=true]:select-none'

/** The drawing area for the current mode. */
export function Stage(props: StageProps): JSX.Element {
  const { mode, stage, scale } = props
  if (!stage || scale <= 0) {
    return <div className="h-full" data-testid="compare-stage-empty" />
  }
  if (mode === 'side') return <SideBySide {...props} stage={stage} />
  return <SingleSheet {...props} stage={stage} />
}

/** How much of each name's end to keep, so the place the two names differ survives the cut. */
const tails = (sides: { older: Side; newer: Side }): { older: number; newer: number } => ({
  older: distinguishingTailLength(sides.older.file.filename, sides.newer.file.filename),
  newer: distinguishingTailLength(sides.newer.file.filename, sides.older.file.filename),
})

/** Whether `side` has the page, so a shorter document can say so instead of drawing nothing. */
const sourceHasPage = (side: Side, page: number): boolean =>
  side.source !== null && hasPage(side.source.pageCount, page)

function SideBySide({ sides, page, stage, scale, regions, activeRegion, pannable }: StageProps & { stage: PageSize }): JSX.Element {
  const t = useTranslations(filesCopy)
  const olderFrame = useRef<HTMLDivElement | null>(null)
  const newerFrame = useRef<HTMLDivElement | null>(null)
  const width = stage.width * scale
  const height = stage.height * scale

  // Moving the other frame fires its own scroll event, which comes back here
  // and finds the two already level: that is what ends the echo.
  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null): void => {
    if (!from || !to) return
    if (to.scrollTop === from.scrollTop && to.scrollLeft === from.scrollLeft) return
    to.scrollTop = from.scrollTop
    to.scrollLeft = from.scrollLeft
  }

  const pane = (key: 'older' | 'newer', frame: typeof olderFrame, other: typeof olderFrame): ReactNode => {
    const side = sides[key]
    const caption = t(key === 'older' ? 'compare.captionOlder' : 'compare.captionNewer')
    const named = t(key === 'older' ? 'compare.paneOlder' : 'compare.paneNewer', { name: side.file.filename })
    return (
      <section aria-label={named} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={`pane-${key}`}>
        <PaneCaption caption={caption} name={side.file.filename} tail={tails(sides)[key]} />
        <div
          ref={frame}
          data-compare-frame=""
          className={cn(FRAME_CLASS, 'flex-1', pannable && PAN_CLASS)}
          onScroll={() => follow(frame.current, other.current)}
        >
          {side.source && sourceHasPage(side, page) && side.size ? (
            <PaperSheet width={width} height={height}>
              <PageCanvas source={side.source} page={page} size={side.size} scale={scale} label={named} />
              {key === 'newer' && <RegionBoxes regions={regions} size={{ width, height }} activeRegion={activeRegion} />}
            </PaperSheet>
          ) : (
            <p className="text-muted-foreground text-sm" data-testid={`missing-${key}`}>
              {t('compare.pageMissing', { n: page })}
            </p>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 md:flex-row" data-testid="stage-side">
      {pane('older', olderFrame, newerFrame)}
      {pane('newer', newerFrame, olderFrame)}
    </div>
  )
}

function SingleSheet({
  mode,
  sides,
  page,
  stage,
  scale,
  opacity,
  divider,
  onDividerChange,
  regions,
  activeRegion,
  pannable,
}: StageProps & { stage: PageSize }): JSX.Element {
  const t = useTranslations(filesCopy)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const overlay = mode === 'overlay'
  const width = stage.width * scale
  const height = stage.height * scale
  const olderName = t('compare.paneOlder', { name: sides.older.file.filename })
  const newerName = t('compare.paneNewer', { name: sides.newer.file.filename })
  // The newer sheet shows right of the divider; the tags are clipped the same
  // way, so each one disappears with the side it names.
  const olderClip: CSSProperties = { clipPath: `inset(0 ${100 - divider}% 0 0)` }
  const newerClip: CSSProperties = { clipPath: `inset(0 0 0 ${divider}%)` }

  const sheet = (key: 'older' | 'newer', label: string, extra?: { className?: string; style?: CSSProperties }): ReactNode => {
    const side = sides[key]
    if (!side.source || !side.size || !sourceHasPage(side, page)) return null
    return (
      <div className={cn('absolute top-0 left-0', extra?.className)} style={extra?.style}>
        <PageCanvas
          source={side.source}
          page={page}
          size={side.size}
          scale={scale}
          ink={overlay ? (key === 'older' ? OLDER_INK : NEWER_INK) : undefined}
          label={label}
        />
      </div>
    )
  }

  return (
    <div
      data-compare-frame=""
      className={cn(FRAME_CLASS, 'h-full', pannable && PAN_CLASS)}
      data-testid={overlay ? 'stage-overlay' : 'stage-swipe'}
    >
      {/* `isolate` plus a white ground (PaperSheet): multiply needs paper to multiply against, in dark mode too. */}
      <PaperSheet ref={trackRef} width={width} height={height}>
        {sheet('older', olderName)}
        {overlay
          ? sheet('newer', newerName, { className: 'mix-blend-multiply', style: { opacity: opacity / 100 } })
          : sheet('newer', newerName, { style: newerClip })}
        {!overlay && (
          <>
            <div className="pointer-events-none absolute inset-0" style={olderClip}>
              <SheetTag side="left" label={t('compare.olderLabel')} name={sides.older.file.filename} tail={tails(sides).older} />
            </div>
            <div className="pointer-events-none absolute inset-0" style={newerClip}>
              <SheetTag side="right" label={t('compare.newerLabel')} name={sides.newer.file.filename} tail={tails(sides).newer} />
            </div>
          </>
        )}
        <RegionBoxes regions={regions} size={{ width, height }} activeRegion={activeRegion} dashed={overlay} />
        {!overlay && <SwipeDivider value={divider} onChange={onDividerChange} trackRef={trackRef} />}
      </PaperSheet>
    </div>
  )
}

type LoadStatus = SideState['status']

/**
 * What the stage says while it cannot show pages: loading, not comparable, or
 * failed. Each final state names what happened, to which file, and offers the
 * one thing that helps: try again, or go to the text comparison.
 */
export function StageNotice({
  older,
  newer,
  olderName,
  newerName,
  onRetry,
  onTextCompare,
  hasTextCompare,
}: {
  older: LoadStatus
  newer: LoadStatus
  olderName: string
  newerName: string
  onRetry: () => void
  onTextCompare: () => void
  /** Whether the host can open the text comparison itself; otherwise the action closes the dialog back to the history. */
  hasTextCompare: boolean
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const states = [older, newer]
  if (states.includes('not-comparable')) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="compare-not-comparable">
        <EmptyState
          icon={FileX2}
          title={t('compare.notComparableTitle')}
          description={t('compare.notComparableDescription')}
          className="max-w-md"
          action={
            <Button variant="outline" data-compare-notice-action="" onClick={onTextCompare}>
              {t(hasTextCompare ? 'compare.openTextCompare' : 'compare.backToHistory')}
            </Button>
          }
        />
      </div>
    )
  }
  if (states.includes('failed')) {
    const title =
      older === 'failed' && newer === 'failed'
        ? t('compare.failedBoth')
        : t('compare.failedFile', { name: older === 'failed' ? olderName : newerName })
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="compare-failed">
        <EmptyState
          icon={AlertTriangle}
          tone="warning"
          title={title}
          description={t('compare.failedDescription')}
          className="max-w-md"
          action={
            <Button variant="outline" data-compare-notice-action="" data-testid="compare-retry" onClick={onRetry}>
              <RotateCw aria-hidden />
              {t('compare.retry')}
            </Button>
          }
        />
      </div>
    )
  }
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm" data-testid="compare-loading">
      <Spinner size="sm" aria-hidden />
      {t('compare.loading')}
    </div>
  )
}
