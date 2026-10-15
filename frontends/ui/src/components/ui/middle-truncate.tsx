import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { DEFAULT_TAIL_LENGTH, splitForMiddleTruncation } from '@/lib/text/middle-truncate'

export interface MiddleTruncateProps {
  /** The full text, also shown as the native tooltip. */
  text: string
  /** Characters always kept at the end. */
  tail?: number
  className?: string
}

/**
 * One line of text that, when it does not fit, loses its MIDDLE and keeps its
 * end: for a file name, whose index and extension are what tell two Fassungen
 * apart. The head ellipsizes in CSS, so the cut follows the width the line
 * actually has; the split itself is `splitForMiddleTruncation`.
 *
 * Never upper-cases or restyles the name: `1OG` and `10G` are a real ambiguity
 * in capitals.
 */
export function MiddleTruncate({ text, tail = DEFAULT_TAIL_LENGTH, className }: MiddleTruncateProps): JSX.Element {
  const split = splitForMiddleTruncation(text, tail)
  return (
    <span className={cn('inline-flex min-w-0 max-w-full whitespace-nowrap', className)} title={text}>
      {/* `whitespace-pre` on both halves: they are flex items, and a flex
          item's leading or trailing space collapses, so a cut that fell next
          to a space ("Plan EG" → "Plan" + " EG") ran the words together. */}
      {split.head && <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">{split.head}</span>}
      <span className="shrink-0 whitespace-pre">{split.tail}</span>
    </span>
  )
}
