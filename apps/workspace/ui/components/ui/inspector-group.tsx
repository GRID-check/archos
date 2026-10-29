import type { HTMLAttributes, JSX, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'

/**
 * The inspector: facts about one object, as inset grouped lists on a sunken
 * rail (the shape of a macOS „Informationen" panel or an iOS settings page).
 *
 * Three parts, and each one is a law the rail used to break:
 *
 *  - `InspectorSection` puts a quiet label directly above its group, closer to
 *    the group it names than to the group before it (proximity). The rail used
 *    to space a section label the same distance from both neighbours, so a
 *    reader could not tell which block a label belonged to without reading it.
 *  - `InspectorGroup` is the common region: one white sheet raised on the rail
 *    holds everything that answers one question. Facts that are one statement
 *    (what Piloti read, and what it took the file to be) used to float as three
 *    loose blocks under one label.
 *  - `InspectorRow` is the one anatomy every label/value fact takes (glyph,
 *    label, value), separated by a hairline inset past the glyph, so the glyph
 *    column reads as one unbroken scan line and each separator divides values,
 *    not the whole row. The row owns the type of both columns: a value carries
 *    no size of its own, so label and value always share one baseline.
 */
export function InspectorSection({
  label,
  icon,
  action,
  className,
  children,
  ...props
}: {
  label: string
  icon?: LucideIcon
  /** A control on the label's line, trailing (a „Korrigieren" link). */
  action?: ReactNode
  className?: string
  children: ReactNode
} & Omit<HTMLAttributes<HTMLElement>, 'children'>): JSX.Element {
  return (
    <section aria-label={label} className={cn('flex flex-col gap-2', className)} {...props}>
      <div className="flex min-h-5 items-center justify-between gap-2 px-3">
        <SectionLabel as="p" icon={icon} className="font-medium tracking-[0.05em]">
          {label}
        </SectionLabel>
        {action}
      </div>
      {children}
    </section>
  )
}

export function InspectorGroup({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      data-slot="inspector-group"
      className={cn(
        'bg-card border-border/70 shadow-2xs overflow-hidden rounded-surface border',
        // The first row's hairline would draw a second edge under the group's
        // own border, so it is the one separator that is never drawn.
        '[&>:first-child>[data-slot=inspector-row-body]]:border-t-0',
        className
      )}
      {...props}
    />
  )
}

export function InspectorRow({
  label,
  icon: Icon,
  children,
  className,
  ...props
}: {
  label: string
  icon: LucideIcon
  children: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'children'>): JSX.Element {
  return (
    <div
      data-slot="inspector-row"
      className={cn('flex gap-2.5 pl-3 text-xs/5', className)}
      {...props}
    >
      {/* The glyph sits in the row's first line box, so it centres on the
          label however many lines the value wraps to. `aria-hidden`: the label
          beside it is already the accessible name. */}
      <span className="flex h-5 shrink-0 items-center self-start pt-2.5 [box-sizing:content-box]">
        <Icon className="text-muted-foreground size-3.5" aria-hidden />
      </span>
      <div
        data-slot="inspector-row-body"
        className="border-border/60 flex min-w-0 flex-1 items-start justify-between gap-3 border-t py-2.5 pr-3"
      >
        {/* The LABEL never truncates: it is the key, and „Proj…" tells the
            reader nothing. A long value wraps in its own column instead. */}
        <span className="text-muted-foreground shrink-0">{label}</span>
        <span className="text-foreground min-w-0 text-right font-medium">{children}</span>
      </div>
    </div>
  )
}
