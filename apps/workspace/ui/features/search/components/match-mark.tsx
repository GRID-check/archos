'use client'

import type { JSX, ReactNode } from 'react'

import { keepUnitsTogether } from '@/lib/text/keep-units'
import type { TextSegment } from '@/lib/text/term-segments'
import { cn } from '@/lib/utils'
import { useCompactRow } from './row-frame'

/** A matched word: set apart by weight on a faint ink wash exactly as wide as the match. */
export function MatchMark({ children, testId }: { children: ReactNode; testId?: string }): JSX.Element {
  // In the palette by weight and ink alone: the wash vanished on the selected
  // row's own tint, which is the row the reader is looking at.
  const compact = useCompactRow()
  return (
    <mark
      className={cn('font-semibold text-foreground', compact ? 'bg-transparent' : 'rounded-[2px] bg-foreground/[0.08] [box-decoration-break:clone]')}
      data-testid={testId}
    >
      {children}
    </mark>
  )
}

/** Text with its matched words set apart; `keepUnits` holds a number to its unit („42,10 m“) as a passage needs. */
export function MatchedSegments({ segments, testId, keepUnits = true }: { segments: readonly TextSegment[]; testId: string; keepUnits?: boolean }): JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <MatchMark key={index} testId={testId}>
            {segment.text}
          </MatchMark>
        ) : (
          <span key={index}>{keepUnits ? keepUnitsTogether(segment.text) : segment.text}</span>
        )
      )}
    </>
  )
}
