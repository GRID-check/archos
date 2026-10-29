import * as React from 'react'

import { cn } from '@/lib/utils'

const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="skeleton"
      // A theme-aware shimmer sweep (`animate-skeleton-shimmer`, on the
      // --motion-ambient cadence) over a `bg-secondary` base — never the flat
      // `bg-accent animate-pulse`, which read as a dead slab in dark mode.
      // The band is a pseudo-element moved by transform (compositor only, no
      // repaint per frame); under reduced motion it stays out of sight and the
      // skeleton is a static block. Radius stays overridable via className
      // (tailwind-merge resolves it against the `rounded-control` default).
      className={cn(
        'bg-secondary animate-skeleton-shimmer rounded-control motion-reduce:animate-none',
        className
      )}
      {...props}
    />
  )
)
Skeleton.displayName = 'Skeleton'

export { Skeleton }
