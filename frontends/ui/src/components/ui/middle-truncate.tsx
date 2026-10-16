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
 * actually has, and a name that fits is shown whole: nothing is cut until the
 * line runs out of room. The split itself is `splitForMiddleTruncation`, which
 * puts the cut between two words where it can.
 *
 * Read once, whole, by assistive technology: the two halves are drawn for the
 * eye and hidden from the accessibility tree, and the full name is there as
 * text. Two flex items read as two items — VoiceOver stopped on „Grundri" and
 * then on „ss_1OG_C.pdf".
 *
 * Never upper-cases or restyles the name: `1OG` and `10G` are a real ambiguity
 * in capitals.
 */
export function MiddleTruncate({ text, tail = DEFAULT_TAIL_LENGTH, className }: MiddleTruncateProps): JSX.Element {
  const split = splitForMiddleTruncation(text, tail)
  if (!split.head) {
    return (
      <span className={cn('inline-flex min-w-0 max-w-full whitespace-nowrap', className)} title={text}>
        <span className="shrink-0 whitespace-pre">{text}</span>
      </span>
    )
  }
  return (
    <span className={cn('inline-flex min-w-0 max-w-full whitespace-nowrap', className)} title={text}>
      <span className="sr-only">{text}</span>
      {/* `whitespace-pre` on both halves: they are flex items, and a flex
          item's leading or trailing space collapses, so a cut that fell next
          to a space ("Plan EG" → "Plan" + " EG") ran the words together. */}
      {/* `min-w-[2ch]`, not `min-w-0`: the head may shrink, but never below
          one letter and the ellipsis. Squeezed to a letter's width it had no
          room left for the „…", so the Files list read „EDachgeschoss.pdf"
          for „Einreichplan_10_Dachgeschoss.pdf", a cut nobody could see. */}
      <span aria-hidden className="min-w-[2ch] overflow-hidden text-ellipsis whitespace-pre">
        {split.head}
      </span>
      <span aria-hidden className="shrink-0 whitespace-pre">
        {split.tail}
      </span>
    </span>
  )
}
