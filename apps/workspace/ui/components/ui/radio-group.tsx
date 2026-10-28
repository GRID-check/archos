'use client'

import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { Circle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE_SMALL } from '@/components/ui/press'

const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root
    ref={ref}
    data-slot="radio-group"
    className={cn('grid gap-2', className)}
    {...props}
  />
))
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName

const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    data-slot="radio-group-item"
    className={cn(
      // Same ring as its sibling `Checkbox` — the offset matters more here, not
      // less: on a 16px circle an offset-less ring lands on the border itself
      // and reads as "this radio is slightly thicker", not as focus.
      'aspect-square size-4 shrink-0 rounded-full border border-input text-primary shadow-xs outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary',
      PRESSABLE_SMALL,
      FOCUS_RING,
      className,
    )}
    {...props}
  >
    {/* The dot lands on `--motion-snap`, the same beat as the Checkbox tick,
        and the same way: mounted always, transitioning on `data-state`, so a
        pre-selected group does not pop its dots in on load. */}
    <RadioGroupPrimitive.Indicator
      forceMount
      className="flex items-center justify-center transition-[opacity,scale] duration-snap ease-out motion-reduce:transition-none data-[state=unchecked]:scale-90 data-[state=unchecked]:opacity-0"
    >
      <Circle className="size-2 fill-primary" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
))
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName

export { RadioGroup, RadioGroupItem }
