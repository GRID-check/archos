import * as React from 'react'
import { Check, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

/**
 * Classes that put a {@link CommentPin}'s square corner on the point its
 * wrapper sits at (`left`/`top` in percent): the bubble rises up and to the
 * right of the point, so it never covers the detail it marks.
 */
export const COMMENT_PIN_ON_POINT = '-translate-y-full'

export interface CommentPinProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The mark's running number, the handle people say aloud („Nummer 4"). Absent for a mark not yet set. */
  number?: number
  /** Whose mark it is, as a colour (`identityInk`, or paper ink for Piloti). */
  color?: string
  /** A suggestion nobody has taken over yet: a dashed ring, never the office's solid one. */
  proposed?: boolean
  /** Resolved or dismissed: quiet, with a tick instead of the number. */
  done?: boolean
  /** The one being read: filled in its colour. */
  active?: boolean
  /** A mark being set right now, not yet saved: a „+" where its number will be. */
  pending?: boolean
  /**
   * A mark of an earlier Fassung, drawn where it stood on that sheet: hollow
   * and dotted, so it never reads as a mark of the sheet under it.
   */
  ghost?: boolean
  /** Its thread has news the reader has not opened: a dot on its shoulder. */
  unread?: boolean
  /** `span` where the pin only shows (inside a row that is itself the button). */
  as?: 'button' | 'span'
}

/**
 * CommentPin — a mark standing on a point of a page: a speech bubble whose one
 * square corner is the point, carrying the mark's NUMBER in mono, ringed in
 * the colour of whoever set it.
 *
 * Number first, because the number is what a room says out loud in a Jour fixe
 * and what a Protokoll lists. One signal per pin: the ring is who, the dash is
 * „not yet the office's", the fill is „this one", the tick is „done", the dots
 * and the hollow face „from an earlier Fassung", the dot on its shoulder
 * „news you have not read". Nothing else rides on twenty-four pixels sitting
 * over somebody's linework.
 */
export const CommentPin = React.forwardRef<HTMLButtonElement, CommentPinProps>(function CommentPin(
  {
    number,
    color = 'var(--paper-ink)',
    proposed,
    done,
    active,
    pending,
    ghost,
    unread,
    as = 'button',
    className,
    style,
    type = 'button',
    ...props
  },
  ref
) {
  const filled = active && !proposed && !ghost
  const classes = cn(
    'relative inline-flex size-6 items-center justify-center rounded-full rounded-bl-none font-mono text-[11px] leading-none font-semibold tabular-nums',
    'border-2 shadow-[0_1px_3px_rgb(0_0_0/0.18)] transition-[scale,background-color,color] duration-snap ease-out motion-reduce:transition-none',
    proposed && 'border-dashed',
    done && 'opacity-60',
    // Hollow: the sheet shows through, the number in the ring's ink.
    ghost && 'border-dotted bg-white/45 shadow-none',
    ghost && active && 'bg-white',
    filled ? 'text-white' : !ghost && 'bg-white text-neutral-900',
    as === 'button' && 'hover:scale-110',
    active && 'scale-110 shadow-[0_2px_8px_rgb(0_0_0/0.25)]',
    className
  )
  const pinStyle: React.CSSProperties = {
    borderColor: color,
    ...(ghost && !filled ? { color } : {}),
    ...(filled ? { backgroundColor: color } : {}),
    ...style,
  }
  const face = done ? (
    <Check className="size-3" strokeWidth={3} aria-hidden />
  ) : pending ? (
    <Plus className="size-3" strokeWidth={3} aria-hidden />
  ) : number === undefined ? null : (
    number
  )
  // Paper ink on a white rim: the pin sits on the white sheet, in either theme.
  const dot = unread ? (
    <span
      data-slot="comment-pin-unread"
      aria-hidden
      className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-white bg-paper-ink"
    />
  ) : null
  if (as === 'span') {
    return (
      <span data-slot="comment-pin" aria-hidden className={cn(classes, 'pointer-events-none')} style={pinStyle}>
        {face}
        {dot}
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
      data-ghost={ghost || undefined}
      data-unread={unread || undefined}
      className={cn(classes, FOCUS_RING)}
      style={pinStyle}
      {...props}
    >
      {face}
      {dot}
    </button>
  )
})
