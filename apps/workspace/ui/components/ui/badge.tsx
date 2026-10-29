'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-control border px-2.5 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1 [&>svg]:size-3.5 [&>svg]:pointer-events-none outline-none transition-colors motion-reduce:transition-none overflow-hidden " +
    FOCUS_RING,
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        success:
          'border-transparent bg-success-subtle text-success',
        warning:
          'border-transparent bg-warning-subtle text-warning',
        info:
          'border-transparent bg-info-subtle text-info',
        // The error in the tinted material its siblings above use (the same
        // pair as Chip, Alert and EmptyState). `destructive` is the solid red
        // plate, for an action-weight warning; a STATUS that says something
        // failed is a fact in a row, and a solid plate made a four-day-old
        // „Fehlgeschlagen" the loudest thing in the Files list.
        danger:
          'border-transparent bg-danger-subtle text-error',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'span'
    return (
      <Comp
        data-slot="badge"
        className={cn(badgeVariants({ variant, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Badge.displayName = 'Badge'

export { Badge, badgeVariants }
