'use client'

import { cn } from '@/lib/utils'

/**
 * A control's resting and busy labels in one grid cell, the inactive one
 * invisible and hidden from the accessibility tree: the control is as wide as
 * its longer label in every state, so „Ablegen" turning into „Wird abgelegt …"
 * nudges neither its neighbours nor the line it sits in. The accessible name
 * is the label that is showing.
 */
export function StackedLabel({
  busy,
  idle,
  working,
  className,
}: {
  busy: boolean
  idle: string
  working: string
  /** On the cell: `text-start` where a glyph sits before the label (a button centres its text). */
  className?: string
}) {
  return (
    <span className={cn('grid', className)}>
      <span className={cn('col-start-1 row-start-1', busy && 'invisible')} aria-hidden={busy}>
        {idle}
      </span>
      <span className={cn('col-start-1 row-start-1', !busy && 'invisible')} aria-hidden={!busy}>
        {working}
      </span>
    </span>
  )
}
