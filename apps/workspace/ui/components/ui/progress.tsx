'use client'

import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'

import { cn } from '@/lib/utils'
import { TONE_INK, type MeterTone } from './segment-meter'

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    /** Fill in a feedback tone's ink (`segment-meter.tsx`) instead of the primary colour. */
    tone?: MeterTone
  }
>(({ className, value, tone, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    data-slot="progress"
    className={cn('bg-secondary relative h-1.5 w-full overflow-hidden rounded-none', className)}
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        'h-full w-full flex-1 rounded-none transition-transform duration-deliberate ease-out motion-reduce:transition-none',
        tone ? cn('bg-current', TONE_INK[tone]) : 'bg-primary'
      )}
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
