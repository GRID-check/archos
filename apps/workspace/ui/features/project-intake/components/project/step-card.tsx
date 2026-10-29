/**
 * The shapes step 1 is drawn in (the approved mockup `Projekt.dc.html`): a
 * card with a head (title, and a count or one quiet action), rows of a label
 * column and a value, and a person's disc. Kept beside the step because only
 * step 1 draws a card this way; the kit's `Card` carries padding and a gap
 * these rows must not have.
 */

import type { ComponentProps, JSX, ReactNode } from 'react'
import { useId } from 'react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { personInitials } from '@/components/ui/avatar-identity'
import { cn } from '@/lib/utils'

export function StepCard({
  title,
  aside,
  children,
  className,
  ...props
}: { title: string; aside?: ReactNode; children: ReactNode } & Omit<ComponentProps<'section'>, 'title'>): JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn('bg-card text-card-foreground min-w-0 rounded-[14px] border', className)} {...props}>
      <div className="flex min-h-[52px] items-center justify-between gap-3 px-4 py-2.5 sm:px-[18px]">
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** One row of a card: a hairline on top, 12px by 18px. */
export function StepCardRow({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div className={cn('border-border/60 flex items-center gap-3 border-t px-4 py-3 sm:px-[18px]', className)} {...props} />
}

/** A fact: the label in a 96px column, the value beside it. */
export function FactRow({ label, children, ...props }: { label: string; children: ReactNode } & Omit<ComponentProps<'div'>, 'children'>): JSX.Element {
  return (
    <StepCardRow className="items-start" {...props}>
      <dt className="text-muted-foreground w-24 shrink-0 pt-px text-[13px]">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm leading-[1.45] [overflow-wrap:anywhere]">{children}</dd>
    </StepCardRow>
  )
}

/** The disc: the reader dark, a colleague on the muted tone, someone from outside dashed. */
export function PersonDisc({ name, tone }: { name: string; tone: 'you' | 'member' | 'external' | 'former' }): JSX.Element {
  return (
    <Avatar aria-hidden className="size-8">
      <AvatarFallback
        className={cn(
          'text-xs font-medium',
          tone === 'you' && 'bg-primary text-primary-foreground',
          tone === 'member' && 'bg-muted text-foreground',
          tone === 'external' && 'bg-card text-muted-foreground border-border border border-dashed',
          tone === 'former' && 'bg-muted text-muted-foreground'
        )}
      >
        {personInitials(name.replace(/^((Mag|DI|Dr|Ing|Arch|arch|Prof|DDI|BSc|MSc)\.?\s+)+/u, ''))}
      </AvatarFallback>
    </Avatar>
  )
}
