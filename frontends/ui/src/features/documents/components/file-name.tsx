'use client'

import type { JSX } from 'react'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { DEFAULT_TAIL_LENGTH, splitForMiddleTruncation } from '@/lib/text/middle-truncate'
import { cn } from '@/lib/utils'

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
  const cut = splitForMiddleTruncation(text, DEFAULT_TAIL_LENGTH).head !== ''
  return (
    <>
      <span aria-hidden={cut || undefined} className={cn('flex min-w-0 max-w-full', className)}>
        <MiddleTruncate text={text} />
      </span>
      {cut && <span className="sr-only">{text}</span>}
    </>
  )
}
