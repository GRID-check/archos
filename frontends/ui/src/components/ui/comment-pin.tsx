import * as React from 'react'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

/**
 * CommentPin — a mark standing on a point of a page: a speech bubble whose one
 * square corner is the point, holding who set it (initials on their identity
 * colour, or a glyph), with the mark's number riding on its shoulder.
 *
 * The square corner, not the bubble's middle, sits on the point
 * ({@link COMMENT_PIN_ON_POINT}): a mark centred on its point covers the very
 * detail it marks, which on a drawing is a door swing or a dimension.
 *
 * - `proposed`: a suggestion nobody has taken over yet. Dashed and on paper
 *   rather than filled, so a machine's finding never looks like the office's.
 * - `done`: resolved or dismissed. Quiet, so open work stays the figure.
 * - `active`: the one being read; lifted and ringed.
 */
export const COMMENT_PIN_ON_POINT = '-translate-y-full'

export interface CommentPinProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** The mark's running number; absent for a mark not yet set. */
  number?: number
  /** What the bubble holds: initials, or a glyph for Piloti. */
  face: React.ReactNode
  /** The identity colour of whoever set it (`identityInk`); ink when absent. */
  color?: string
  proposed?: boolean
  done?: boolean
  active?: boolean
  /** `span` where the pin only shows (inside a row that is itself the button). */
  as?: 'button' | 'span'
}

export const CommentPin = React.forwardRef<HTMLButtonElement, CommentPinProps>(function CommentPin(
  {
    number,
    face,
    color,
    proposed,
    done,
    active,
    as = 'button',
    className,
    style,
    type = 'button',
    ...props
  },
  ref
) {
  const body = (
    <>
      <span
        className={cn(
          'flex size-full items-center justify-center rounded-full rounded-bl-none text-[10px] font-semibold tracking-tight',
          proposed
            ? 'bg-card text-foreground border-foreground/70 border border-dashed'
            : 'text-white',
          done && 'opacity-55'
        )}
        style={proposed ? undefined : { backgroundColor: color ?? 'var(--foreground)' }}
      >
        {face}
      </span>
      {number !== undefined && (
        <span
          aria-hidden
          className="bg-foreground text-background absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums leading-none ring-2 ring-white"
        >
          {number}
        </span>
      )}
    </>
  )
  const classes = cn(
    'group/pin relative inline-flex size-7 rounded-full rounded-bl-none p-[3px] shadow-md ring-1 ring-black/10',
    'bg-white transition-transform duration-snap ease-out motion-reduce:transition-none',
    'hover:scale-110',
    active && 'scale-115 shadow-lg ring-2 ring-foreground',
    as === 'span' && 'pointer-events-none size-6 shadow-sm hover:scale-100',
    className
  )
  if (as === 'span') {
    return (
      <span data-slot="comment-pin" aria-hidden className={classes} style={style}>
        {body}
      </span>
    )
  }
  return (
    <button
      ref={ref}
      type={type}
      data-slot="comment-pin"
      data-active={active || undefined}
      data-proposed={proposed || undefined}
      className={cn(classes, FOCUS_RING)}
      style={style}
      {...props}
    >
      {body}
    </button>
  )
})
