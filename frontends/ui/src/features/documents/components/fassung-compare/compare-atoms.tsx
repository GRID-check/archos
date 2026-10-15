'use client'

/**
 * The comparison's own atoms: the few shapes it draws that the product kit
 * does not have, each decided once so the boxes, the list and the legend are
 * visibly the same material.
 *
 * Anything that sits ON the sheet (a tag, a box, its number) takes the paper
 * palette (`--compare-*`, set from `lib/tint.ts` on the dialog), never a theme
 * token: the sheet is white in both themes, and a token flips with the theme.
 */

import type { CSSProperties, JSX, ReactNode } from 'react'
import { forwardRef } from 'react'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import { rgbCss, type Rgb } from './lib/tint'

/**
 * A change's number, the same chip on the box and on its row so the two read
 * as one object. `active` rings it (in the list; on the sheet the box itself
 * carries the highlight).
 */
export function ChangeBadge({ number, active = false, className }: { number: number; active?: boolean; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-sm bg-[var(--compare-mark)] text-[11px] leading-none font-semibold text-[var(--compare-paper)] tabular-nums',
        active && 'ring-2 ring-[var(--compare-mark)] ring-offset-1 ring-offset-background',
        className,
      )}
    >
      {number}
    </span>
  )
}

/** A colour key's square: the ink exactly as the sheet draws it, edged so a pale ink still has a shape. */
export function Swatch({ ink }: { ink: Rgb }): JSX.Element {
  return <span aria-hidden className="ring-border size-3 shrink-0 rounded-[3px] ring-1" style={{ background: rgbCss(ink) }} />
}

/** One entry of a colour key: swatch and words, so colour is never the only carrier. */
export function SwatchLabel({ ink, children, title }: { ink: Rgb; children: ReactNode; title?: string }): JSX.Element {
  return (
    <li className="text-foreground flex items-center gap-1.5" title={title}>
      <Swatch ink={ink} />
      {children}
    </li>
  )
}

/** The most of a name's end a sheet tag keeps: an index and its extension (`_Index_C.pdf`). */
const TAG_TAIL = 12

/**
 * A label pinned to a corner of the sheet („Älter", „Neuer") with the file's
 * name, for the swipe view, where nothing else on screen says which side is
 * which.
 */
export function SheetTag({ side, label, name, tail, style }: { side: 'left' | 'right'; label: string; name: string; tail?: number; style?: CSSProperties }): JSX.Element {
  return (
    <span
      data-testid={`sheet-tag-${side}`}
      className={cn(
        // `overflow-hidden` as the last word: the name's kept tail does not
        // shrink, and on a 361px sheet „Neuer" plus a long tail ran past the
        // sheet's edge and was cut at „pdf". The tail is held short enough
        // (`TAG_TAIL`) that the index survives inside the tag.
        'pointer-events-none absolute top-2 z-[5] flex max-w-[calc(50%-0.75rem)] min-w-0 items-center gap-1.5 overflow-hidden rounded-sm bg-[var(--compare-paper-ink)] px-1.5 py-0.5 text-xs text-[var(--compare-paper)] shadow-sm',
        side === 'left' ? 'left-2' : 'right-2',
      )}
      style={style}
    >
      <span className="shrink-0 font-semibold">{label}</span>
      <MiddleTruncate text={name} tail={Math.min(tail ?? TAG_TAIL, TAG_TAIL)} className="min-w-0 opacity-80" />
    </span>
  )
}

/**
 * The white sheet a page is drawn on, sized to the shared stage and centred in
 * its frame (the frame is a flex box; auto margins centre a smaller sheet and
 * fall to zero for a larger one, so a zoomed sheet still scrolls from its edge). The hairline ring finds the sheet's edge on the dark theme and
 * where the swipe clip hides one side.
 */
export const PaperSheet = forwardRef<HTMLDivElement, { width: number; height: number; children: ReactNode }>(
  function PaperSheet({ width, height, children }, ref) {
    return (
      <div
        ref={ref}
        className="ring-border relative isolate m-auto shrink-0 bg-[var(--compare-paper)] shadow-sm ring-1"
        style={{ width, height }}
      >
        {children}
      </div>
    )
  },
)

/**
 * A pane's caption: what it is („Ältere Fassung") as an eyebrow, and the file
 * name in its own case beside it, cut in the middle so its index survives.
 */
export function PaneCaption({ caption, name, tail }: { caption: string; name: string; tail?: number }): JSX.Element {
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 px-4">
      <SectionLabel className="shrink-0">{caption}</SectionLabel>
      <MiddleTruncate text={name} tail={tail} className="text-foreground text-xs" />
    </div>
  )
}

/**
 * The strip under the sheet: what the current view needs explained (the
 * overlay's colour key and fader) on the left, the keys on the right. Present
 * in every view at one height, so switching views never moves the sheet.
 */
export function StageBar({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div
      data-testid="compare-stage-bar"
      className={cn('flex min-h-11 flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-4 py-1.5 text-sm', className)}
    >
      {children}
    </div>
  )
}
