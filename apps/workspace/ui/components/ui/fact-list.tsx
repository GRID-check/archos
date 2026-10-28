import type { HTMLAttributes, JSX, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * A compact list of label/value facts inside a rail block, where an
 * {@link InspectorRow} (a full-width row with a glyph) would be too heavy: the
 * facts a document states, its parties, its dates. The label never truncates;
 * the value wraps in its own column; `meta` (a page, a unit note) trails in
 * muted ink.
 */
export function FactList({ className, ...props }: HTMLAttributes<HTMLDListElement>): JSX.Element {
  return <dl data-slot="fact-list" className={cn('flex flex-col gap-1 text-xs/5', className)} {...props} />
}

export function FactRow({
  label,
  children,
  meta,
  className,
  ...props
}: {
  label: ReactNode
  children: ReactNode
  /** Trailing, muted: where the fact was read („S. 2“). */
  meta?: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>): JSX.Element {
  return (
    <div data-slot="fact-row" className={cn('flex items-baseline justify-between gap-3', className)} {...props}>
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-foreground flex min-w-0 items-baseline gap-1.5 text-right font-medium">
        <span className="min-w-0 break-words">{children}</span>
        {meta && <span className="text-muted-foreground shrink-0 font-normal tabular-nums">{meta}</span>}
      </dd>
    </div>
  )
}

/** A quiet heading over one block of a rail („Verweist auf“), smaller than a section label. */
export function FactBlockTitle({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cn('text-muted-foreground text-[11px] font-medium', className)} {...props} />
}
