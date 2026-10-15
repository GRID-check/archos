'use client'

import type { JSX } from 'react'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { DEFAULT_TAIL_LENGTH, splitForMiddleTruncation } from '@/lib/text/middle-truncate'
import { cn } from '@/lib/utils'

/**
 * How much of the end to keep: the last segment and the extension
 * (`_Rohbau.jpg`), not a fixed sixteen characters. On a 156px card a fixed
 * tail left the head three letters ("Ba…") although the name nearly fit; the
 * last segment is what tells two files apart, and the rest may shrink.
 * Segments are `_` and space (a `-` sits inside drawing numbers: `A-101`), a
 * name without one keeps the default, and the tail stays between 8 and the
 * default.
 */
function tailOf(text: string): number {
  const cut = Math.max(text.lastIndexOf('_'), text.lastIndexOf(' '))
  if (cut < 0) return DEFAULT_TAIL_LENGTH
  return Math.min(DEFAULT_TAIL_LENGTH, Math.max(8, text.length - cut))
}

/**
 * A document's or folder's name on a tile or a row: the end of it survives.
 *
 * Revision, drawing number and extension are the END of a name
 * (`Lageplan_Baufeld_Nord_Rev_C_Freigabe.pdf`), and a finger has no tooltip to
 * read the rest, so a long name loses its middle (`MiddleTruncate`) and never
 * its tail.
 *
 * A name that is cut is drawn as two boxes, which a screen reader can read as
 * two words ("Lageplan_Baufe" "ld_Rev_C.pdf"). The drawn pair is hidden from
 * assistive technology and the whole name is read once, in text only it sees.
 * A name that fits is one box and needs neither.
 *
 * The wrapper owns the width (`min-w-0`), so it truncates inside a flex row.
 */
export function FileName({ text, className }: { text: string; className?: string }): JSX.Element {
  const tail = tailOf(text)
  const cut = splitForMiddleTruncation(text, tail).head !== ''
  return (
    <>
      <span aria-hidden={cut || undefined} className={cn('flex min-w-0 max-w-full', className)}>
        <MiddleTruncate text={text} tail={tail} />
      </span>
      {cut && <span className="sr-only">{text}</span>}
    </>
  )
}
