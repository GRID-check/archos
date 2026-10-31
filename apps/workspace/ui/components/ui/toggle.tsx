'use client'

import * as React from 'react'
import * as TogglePrimitive from '@radix-ui/react-toggle'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

const toggleVariants = cva(
  // One radius for the whole scale (`rounded-control`, 4px): the `inverted`
  // variant once overrode the base, so two toggles in the same filter row
  // rounded differently depending on which variant they were.
  //
  // Press dip: `scale` (what v4's `active:scale-*` sets) joins the transition list at the snap duration while
  // colors stay at quick (the Button press split). Transform-only motion, so
  // no layout shift.
  "inline-flex items-center justify-center gap-1.5 rounded-control text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,opacity,scale] [transition-duration:var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-snap)] ease-out outline-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 motion-reduce:transition-none active:scale-[0.98] motion-reduce:active:scale-100 " +
    FOCUS_RING,
  {
    variants: {
      variant: {
        default: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground',
        outline:
          'border border-border bg-transparent text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground data-[state=on]:border-border data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-xs',
        inverted:
          'text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:shadow-2xs',
        // One segment of a `ToggleSegments` track: the tab strip's material
        // (a card pill lifted off the muted track), for a choice that is
        // buttons rather than tabs, because nothing below it is a tab panel.
        segment:
          'text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs',
      },
      // Aligned to `Button`'s size scale, one name = one height, so a toggle
      // and a button placed side by side in a toolbar line up. The scale used
      // to sit one step low (Toggle `default` was Button `sm`), which is why
      // every filter row next to a button read a notch short.
      // `min-w-11` alongside `h-11`, for the same reason Button carries both
      // (see `touch-target.spec.ts`): height alone leaves a SHORT LABEL under the
      // floor on the axis nobody checks. Measured on the Archiv category filters,
      // "All" came out 40px wide inside a 44px-tall pill — a control that passes
      // every height assertion and is still too narrow to hit, in a row where the
      // chip beside it is three times the width and hits fine.
      size: {
        default: 'h-9 px-3 text-sm pointer-coarse:h-11 pointer-coarse:min-w-11',
        sm: 'h-8 px-3 text-xs pointer-coarse:h-11 pointer-coarse:min-w-11',
        // Button's `xs` step: 28px, inside a dense panel or a card.
        xs: "h-7 px-2.5 text-xs pointer-coarse:h-11 pointer-coarse:min-w-11 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-10 px-3.5 pointer-coarse:h-11 pointer-coarse:min-w-11',
        // Icon sizes are the glyph's own square and are NOT part of that
        // remap — they pair with `Button size="icon"` by area, not by height.
        icon: 'size-8 pointer-coarse:size-11',
        'icon-sm': 'size-7 px-0 pointer-coarse:size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    data-slot="toggle"
    className={cn(toggleVariants({ variant, size, className }))}
    {...props}
  />
))
Toggle.displayName = TogglePrimitive.Root.displayName

/**
 * A row of pressed-or-not `Toggle`s on one muted track, the one on in a card
 * pill (`variant="segment"`): Offen / Erledigt over a list, the kind of a mark.
 * Each segment is a button with `aria-pressed`, reached by Tab, and the caller
 * keeps exactly one on. Not `ToggleGroup type="single"`, which is a radio group
 * and owes arrow keys; not `Tabs`, which owe a tab panel. Name the group with
 * `aria-label`.
 */
function ToggleSegments({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      role="group"
      data-slot="toggle-segments"
      className={cn('bg-muted inline-flex w-fit max-w-full items-center rounded-control p-0.5', className)}
      {...props}
    />
  )
}

export { Toggle, ToggleSegments, toggleVariants }
