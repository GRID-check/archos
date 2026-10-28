import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * PathChange — a move as a before and an after: where something is now,
 * struck through and muted, and „→ where it would go" under it, with a mark
 * after the target („neu"). Both in the mono face, because a path is read
 * segment by segment. Neither is ever cut: a path wraps, even inside a long
 * segment, since it is what the person decides on.
 *
 * The strike-through is not spoken, so each line carries a label for a screen
 * reader (`fromLabel`, `toLabel`); the arrow is decoration.
 */
export function PathChange({
  from,
  to,
  toMark,
  fromLabel,
  toLabel,
  className,
}: {
  /** Where it is now. Left out when that is not known: the after stands alone. */
  from?: ReactNode
  to: ReactNode
  toMark?: ReactNode
  fromLabel: string
  toLabel: string
  className?: string
}): JSX.Element {
  return (
    <div data-slot="path-change" className={cn('grid gap-0.5 font-mono text-[11.5px] leading-snug', className)}>
      {from !== undefined && from !== null && (
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          <span className="sr-only">{fromLabel} </span>
          <s className="decoration-muted-foreground/60">{from}</s>
        </p>
      )}
      <p className="text-foreground flex items-baseline gap-1.5">
        <span aria-hidden className="text-muted-foreground font-sans">
          →
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="sr-only">{toLabel} </span>
          {to}
        </span>
        {toMark && <span className="font-sans">{toMark}</span>}
      </p>
    </div>
  )
}
