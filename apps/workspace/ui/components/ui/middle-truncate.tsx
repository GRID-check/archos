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
 * puts the cut between two words where it can. When the line is narrower than
 * the tail itself, the head is gone and the tail loses its start instead, behind
 * a leading „…" (`…schoss.pdf`): never a hard edge with no sign of a cut.
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
        <LastResortTail text={text} />
      </span>
    )
  }
  return (
    <span className={cn('inline-flex min-w-0 max-w-full whitespace-nowrap', className)} title={text}>
      <span className="sr-only">{text}</span>
      {/* `whitespace-pre` on both halves: they are flex items, and a flex
          item's leading or trailing space collapses, so a cut that fell next
          to a space ("Plan EG" → "Plan" + " EG") ran the words together.
          The head gives way first (its shrink factor dwarfs the tail's), all
          the way to nothing; only then does the tail. */}
      <span aria-hidden data-part="head" className="min-w-0 shrink-[100000] overflow-hidden text-ellipsis whitespace-pre">
        {split.head}
      </span>
      <LastResortTail text={split.tail} aria-hidden />
    </span>
  )
}

/**
 * The end of the name, kept whole while there is room and, when there is not
 * even room for that, cut at its START with a leading „…": `…schoss.pdf`, so
 * the extension and the index survive and the cut is always visible.
 *
 * It used to be `shrink-0`, and a column narrower than the tail sliced it at
 * the cell's edge mid-letter, with no ellipsis: „W.Gesamtmc" in a narrow Files
 * list. The leading ellipsis is the right-to-left box's END ellipsis; the text
 * inside is isolated left-to-right (`<bdi dir="ltr">`), so `(2).pdf` and a
 * leading digit keep their order.
 */
function LastResortTail({ text, ...rest }: { text: string; 'aria-hidden'?: boolean }): JSX.Element {
  return (
    <span {...rest} data-part="tail" dir="rtl" className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">
      <bdi dir="ltr">{text}</bdi>
    </span>
  )
}
