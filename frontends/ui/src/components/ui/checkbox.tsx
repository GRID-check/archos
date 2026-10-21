'use client'

import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { CheckIcon, MinusIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE_SMALL } from '@/components/ui/press'

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    data-slot="checkbox"
    className={cn(
      // 16px is the right SIZE for a checkbox and a hopeless touch target, so
      // the box keeps its size and `touch-target` widens what a tap resolves to.
      'peer border-input dark:bg-input-background data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary size-4 shrink-0 rounded-sm border outline-none disabled:cursor-not-allowed disabled:opacity-50 touch-target',
      PRESSABLE_SMALL,
      // `dark:bg-input-dark` and `data-[state=checked]:bg-primary` have equal
      // specificity, and the dark variant is emitted last — so in dark mode a
      // CHECKED box kept the unchecked fill and drew its dark tick on it,
      // which is invisible. Re-assert the checked fill under `dark:` so the
      // two conditions compose instead of one silently winning.
      'dark:data-[state=checked]:bg-primary dark:data-[state=checked]:text-primary-foreground',
      // Half-filled is a state of its own, drawn as filled ink with a dash. It
      // used to share the unchecked paint and the tick, so a master box over
      // „some" read as „checked, but disabled" — the one state it exists for.
      'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:border-primary',
      'dark:data-[state=indeterminate]:bg-primary dark:data-[state=indeterminate]:text-primary-foreground',
      FOCUS_RING,
      'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      // The tick lands with the fill, on `--motion-snap`: a fade and a 90%
      // scale, so it reads as set down rather than switched on. Radix unmounts
      // the indicator when the box empties, so there is no exit to time; the
      // fill fading behind it carries the un-tick.
      className={cn(
        'group/indicator flex items-center justify-center text-current',
        'animate-in fade-in-0 zoom-in-90 duration-snap ease-out motion-reduce:animate-none'
      )}
    >
      {/* The indicator carries the root's `data-state`, so one of the two glyphs shows. */}
      <CheckIcon data-slot="checkbox-check" className="size-3.5 group-data-[state=indeterminate]/indicator:hidden" />
      <MinusIcon data-slot="checkbox-dash" className="hidden size-3.5 group-data-[state=indeterminate]/indicator:block" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
