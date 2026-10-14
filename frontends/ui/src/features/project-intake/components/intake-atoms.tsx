import type { JSX, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { CountPill } from '@/components/ui/count-pill'

/**
 * The setup page's own atoms: the section frame every part of the review sits
 * in, and the mark for a value that decides the Gebäudeklasse. One place, so
 * the four sections cannot drift apart on spacing or heading size.
 */

export function IntakeSection({
  label,
  count,
  description,
  children,
  testId,
}: {
  label: string
  count?: number
  description?: string
  children: ReactNode
  testId?: string
}): JSX.Element {
  return (
    <section aria-label={label} className="space-y-3" data-testid={testId}>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">{label}</h2>
          {count !== undefined && <CountPill>{count}</CountPill>}
        </div>
        {description && <p className="text-muted-foreground max-w-prose text-sm">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** A value that decides the class of a building. Words, not a colour alone. */
export function DecisiveBadge({ label, title }: { label: string; title: string }): JSX.Element {
  return (
    <Badge variant="warning" title={title}>
      {label}
    </Badge>
  )
}
