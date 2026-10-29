import type { JSX } from 'react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The ground a document is laid ON: a recessed tray with a faint drafting grid.
 *
 * The file peek used to put its page on the pane's own card colour with a
 * gradient too shallow to see, so a drawing narrower than the column floated
 * in white space and a PDF brought a bordered scroller of its own — two
 * frames, neither of which said "this is the document". One recessed plane
 * instead: sunken one step below the card (the direction inputs take, never
 * raised), a hairline, a 1px inner shadow along the top edge where light from
 * above would fall, and the dot grid an architect's drawing paper carries.
 * The page on it keeps its own white and its own shadow, so it reads as a
 * sheet on a desk.
 *
 * Shape only. What sits on it, and how it scrolls, is the caller's.
 */
export function InsetStage({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="inset-stage"
      className={cn(
        'bg-surface-sunken bg-drafting-grid border-base relative min-h-0 min-w-0 overflow-hidden rounded-surface border',
        'shadow-[inset_0_1px_2px_0_color-mix(in_oklch,var(--foreground)_6%,transparent)]',
        className,
      )}
      {...props}
    />
  )
}
