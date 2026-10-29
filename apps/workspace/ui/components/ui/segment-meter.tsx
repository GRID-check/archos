import type { JSX } from 'react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The five feedback tones as INK, for marks that are filled rather than tinted.
 * A chip carries a tone as a tint pair (`chip.tsx`); a swatch and a meter
 * segment are solid, so they read the tone's text colour and fill with it
 * (`bg-current`). One table, so a retune of a feedback token moves both.
 */
export type MeterTone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'

export const TONE_INK: Record<MeterTone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  destructive: 'text-error',
  muted: 'text-muted-foreground/45',
}

/**
 * The status mark of the design language: a 10px square in the tone's ink,
 * always beside a word. Colour alone never carries the meaning, so this has no
 * label of its own and is hidden from assistive technology — the word beside
 * it is what is read.
 */
export function ToneSwatch({ tone, className }: { tone: MeterTone; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      data-slot="tone-swatch"
      className={cn('inline-block size-2.5 shrink-0 rounded-control bg-current', TONE_INK[tone], className)}
    />
  )
}

export interface MeterSegment {
  key: string
  value: number
  tone: MeterTone
}

export interface SegmentMeterProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  segments: readonly MeterSegment[]
  /**
   * What the bar says, in words — required, because a row of coloured lengths
   * is not something a screen reader can describe. Typically the same sentence
   * the surface prints beside it.
   */
  label: string
}

/**
 * The narrowest a drawn segment may be, as a share of the track: a state with
 * one file in a thousand still shows as a sliver rather than vanishing (3% is
 * about 4px on the folder brief's track).
 */
const MIN_SHARE = 0.03

/**
 * Where each drawn segment ENDS along the track, as a share of it: cumulative,
 * with every segment held to at least `MIN_SHARE` and the last one ending at
 * exactly 1, so rounding can never leave a gap at the end or push past it.
 */
export function segmentEnds(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0 || values.length === 0) return []
  const raw = values.map((value) => Math.max(value / total, MIN_SHARE))
  const scale = raw.reduce((sum, share) => sum + share, 0)
  let end = 0
  return raw.map((share, index) => {
    end = index === raw.length - 1 ? 1 : end + share / scale
    return end
  })
}

/**
 * A single bar split into proportional segments: how a whole divides into
 * states (read / being read / failed). Zero-valued segments are not drawn; an
 * all-zero meter is an empty track, never a full one.
 *
 * Every segment is a full-width layer scaled from the left edge to where it
 * ends (`scaleX`), drawn first-on-top, so each one shows only between its
 * neighbour's end and its own. A change of counts is therefore a TRANSFORM
 * transition, which the compositor runs; it was a `flex-grow` transition,
 * which re-ran layout every frame. The hairline between two segments rides on
 * its own layer, translated to the boundary (a scaled element would scale its
 * hairline too).
 */
export function SegmentMeter({ segments, label, className, ...props }: SegmentMeterProps): JSX.Element {
  const drawn = segments.filter((segment) => segment.value > 0)
  const ends = segmentEnds(drawn.map((segment) => segment.value))
  return (
    <div
      role="img"
      aria-label={label}
      data-slot="segment-meter"
      className={cn('bg-muted relative isolate h-2 w-full overflow-hidden rounded-none', className)}
      {...props}
    >
      {drawn.map((segment, index) => (
        <span
          key={segment.key}
          data-segment={segment.key}
          className={cn(
            'absolute inset-0 origin-left bg-current transition-transform duration-base ease-out motion-reduce:transition-none',
            TONE_INK[segment.tone]
          )}
          style={{ transform: `scaleX(${ends[index]})`, zIndex: drawn.length - index }}
        />
      ))}
      {ends.slice(0, -1).map((end, index) => (
        <span
          key={`gap-${drawn[index].key}`}
          aria-hidden
          data-segment-gap
          className="absolute inset-0 transition-transform duration-base ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(${end * 100}%)`, zIndex: drawn.length + 1 }}
        >
          <span className="bg-muted absolute inset-y-0 -left-px w-px" />
        </span>
      ))}
    </div>
  )
}
