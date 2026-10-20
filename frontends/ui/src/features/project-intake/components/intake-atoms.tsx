import type { JSX, ReactNode } from 'react'
import { Building2, TriangleAlert } from 'lucide-react'
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
  action,
  children,
  testId,
}: {
  label: string
  count?: number
  description?: string
  /** The section's one action for all it holds, beside the heading. */
  action?: ReactNode
  children: ReactNode
  testId?: string
}): JSX.Element {
  return (
    <section aria-label={label} className="space-y-3" data-testid={testId}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">{label}</h2>
            {count !== undefined && <CountPill>{count}</CountPill>}
          </div>
          {description && <p className="text-muted-foreground max-w-prose text-sm">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * A value that decides the class of a building: a property of the value, not an
 * alarm, so it is neutral. A glyph and the words, never a colour alone.
 */
export function DecisiveBadge({ label, title }: { label: string; title: string }): JSX.Element {
  return (
    <Badge variant="outline" title={title}>
      <Building2 aria-hidden />
      {label}
    </Badge>
  )
}

/** A value the documents disagree on: the one badge on the page that asks for attention. */
export function ContestedBadge({ label }: { label: string }): JSX.Element {
  return (
    <Badge variant="warning">
      <TriangleAlert aria-hidden />
      {label}
    </Badge>
  )
}
