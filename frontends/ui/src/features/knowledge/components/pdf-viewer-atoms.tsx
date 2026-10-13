/**
 * The PDF viewer's own atoms: the sheet a page is drawn on, and the small copy
 * of it the page rail shows.
 *
 * One sheet for every place a page appears — the page itself, the page-shaped
 * placeholder it arrives into, the thumbnail — so the three cannot drift apart
 * on the first token retune. A page is paper in both themes: the stage around
 * it carries the theme, the sheet stays white, the way a printed page on a
 * dark desk is still white.
 */

import type { ComponentProps, JSX } from 'react'
import { forwardRef } from 'react'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { cn } from '@/lib/utils'

/**
 * A raised sheet of paper: white, a soft shadow and a hairline, with the
 * hairline promoted to ink under `prefers-contrast: more`, where a sheet that
 * only a shadow separates from a pale stage disappears.
 */
export const PageSheet = forwardRef<HTMLDivElement, ComponentProps<'div'>>(function PageSheet(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="page-sheet"
      className={cn(
        'relative shrink-0 bg-white shadow-sm ring-1 ring-border contrast-more:ring-foreground/50',
        className,
      )}
      {...props}
    />
  )
})

/**
 * One entry in the page rail: a button holding a small sheet and its number.
 * The current page wears an ink ring around its sheet — the same ink as focus,
 * held off the sheet by a gap so the two never read as one — and its number
 * goes to full ink.
 */
export function PageThumbnailButton({
  current,
  number,
  className,
  children,
  ...props
}: ComponentProps<'button'> & { current: boolean; number: number }): JSX.Element {
  return (
    <button
      type="button"
      aria-current={current ? 'page' : undefined}
      className={cn(
        'group/thumb flex w-full shrink-0 flex-col items-center gap-1 rounded-md p-1.5 outline-none',
        'hover:bg-accent/60 transition-colors duration-quick ease-out',
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'block w-full ring-offset-2 ring-offset-surface-sunken',
          current && 'ring-2 ring-ring/60 contrast-more:ring-foreground',
        )}
      >
        {children}
      </span>
      <span
        aria-hidden
        className={cn(
          'text-[11px] leading-none tabular-nums',
          current ? 'text-foreground font-medium' : 'text-muted-foreground contrast-more:text-foreground',
        )}
      >
        {number}
      </span>
    </button>
  )
}
