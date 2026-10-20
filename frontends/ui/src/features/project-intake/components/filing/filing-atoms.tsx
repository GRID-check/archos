'use client'

import type { ComponentProps, JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The Ablage's two materials, as the approved mockup draws them: a card
 * (`bg-card`, hairline, 14px corners) and, inside the summary card, a block
 * with a glyph, a line, a muted line and one quiet link.
 */
export function FilingCard({ className, ...rest }: ComponentProps<'section'>): JSX.Element {
  return <section className={cn('bg-card border-border min-w-0 rounded-[14px] border', className)} {...rest} />
}

/** The page's head: one question, one muted line, and an optional quiet link after it. */
export function FilingHead({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="text-muted-foreground mt-2 text-sm">{children}</p>}
    </header>
  )
}

export function SummaryBlock({
  icon,
  title,
  body,
  action,
  testId,
}: {
  icon?: ReactNode
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
  testId?: string
}): JSX.Element {
  return (
    <div className="border-border/60 flex gap-2 border-t px-[18px] py-4 first:border-t-0" data-testid={testId}>
      {icon && <span className="mt-0.5 flex shrink-0 [&>svg]:size-4">{icon}</span>}
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm">{title}</p>
        {body && <p className="text-muted-foreground text-xs">{body}</p>}
        {action && <div className="pt-1.5 text-[13px]">{action}</div>}
      </div>
    </div>
  )
}
