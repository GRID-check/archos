import type { HTMLAttributes, JSX, LabelHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { cn } from '@/lib/utils'

/**
 * The upload dialog's own atoms: the material its decisions are drawn in.
 *
 * Every answer in the dialog has one shape — a box, then two lines: WHAT (a
 * file name, a count) and WHY or WHERE TO, quieter, under it. The same-name
 * update, the master box over forty proposals, one proposal and one file that
 * needs a choice are four arrangements of that one row, so they read as one
 * family (ADR-0099: a same-name re-upload and a file under another name are both
 * a new Fassung). Rows stack under each other rather than in table columns: a
 * second column was what ran off the dialog's edge at 512px and vanished on a
 * phone.
 */

/** A decision block: a heading with its glyph, and what is decided under it. */
export function DecisionSection({
  icon: Icon,
  title,
  children,
  className,
  ...props
}: {
  icon: LucideIcon
  title: ReactNode
  children: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLElement>, 'title'>): JSX.Element {
  return (
    <section className={cn('space-y-3 rounded-surface border p-3', className)} {...props}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{title}</span>
      </h3>
      {children}
    </section>
  )
}

/**
 * One answer: a box and two lines. A `<label>`, so a tap anywhere on the row
 * toggles the box, not only on its 16px square. `muted` is a row whose box is
 * not ticked: still readable, visibly not going in as what the box says.
 */
export function DecisionRow({
  control,
  title,
  detail,
  muted = false,
  className,
  ...props
}: {
  control: ReactNode
  title: ReactNode
  detail?: ReactNode
  muted?: boolean
  className?: string
} & Omit<LabelHTMLAttributes<HTMLLabelElement>, 'title'>): JSX.Element {
  return (
    <label
      className={cn('flex min-w-0 cursor-pointer items-start gap-3 py-1.5', className)}
      data-muted={muted || undefined}
      {...props}
    >
      <span className="flex h-5 shrink-0 items-center">{control}</span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block min-w-0 text-sm text-foreground">{title}</span>
        {detail && (
          <span className={cn('block min-w-0 text-xs text-muted-foreground', muted && 'opacity-60')}>{detail}</span>
        )}
      </span>
    </label>
  )
}

/**
 * The bar a group's master box sits in. Sticky inside the dialog's one scroll
 * region, so while forty rows go past, the box that decides them and the count
 * („33 von 34") stay in sight. Opaque, or the rows would show through it.
 */
export function DecisionBar({ children, className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn('sticky top-0 z-10 -mx-3 border-b bg-popover px-3 pb-1', className)}
      {...props}
    >
      {children}
    </div>
  )
}

/** A folder's name over its run of rows: the tree the files came from. */
export function DecisionGroupLabel({ children, count }: { children: ReactNode; count: number }): JSX.Element {
  return (
    <p className="flex min-w-0 items-center gap-1.5 pt-2 text-xs font-medium text-muted-foreground">
      <span className="min-w-0">{children}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </p>
  )
}

/** A line of explanation inside a decision block. */
export function DecisionNote({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <p className={cn('text-xs text-muted-foreground', className)}>{children}</p>
}

/** A group inside a decision block that asks something different of the reader, set off by a hairline. */
export function DecisionSubgroup({
  title,
  children,
  ...props
}: { title: ReactNode; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'title'>): JSX.Element {
  return (
    <div className="space-y-1 border-t pt-3" {...props}>
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      {children}
    </div>
  )
}

/** What hangs under a row's text, aligned with it rather than with the box: a picker, say. */
export function DecisionRowExtra({ children }: { children: ReactNode }): JSX.Element {
  return <div className="min-w-0 pb-1.5 pl-7">{children}</div>
}

/**
 * Where a file goes: „→ Fassung von EG_Grundriss_Index_B.pdf · Index B". The
 * arrow, the words before it and the label never shrink. The label already says
 * what tells this document apart (its index and date), so the name before it may
 * lose its END, down to a few characters on a phone; without a label the name's
 * end is what tells it apart, so then it loses its middle instead.
 */
export function DecisionTarget({ prefix, name, label }: { prefix: string; name: string; label?: string }): JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      {/* The spaces between the pieces are for the text a screen reader reads; the gap draws them. */}
      <span aria-hidden className="shrink-0">
        →
      </span>{' '}
      <span className="shrink-0">{prefix}</span>{' '}
      {label ? (
        <span className="min-w-[4rem] truncate" title={name}>
          {name}
        </span>
      ) : (
        <MiddleTruncate text={name} tail={16} className="min-w-0" />
      )}
      {label && (
        <>
          {' '}
          <span className="shrink-0">· {label}</span>
        </>
      )}
    </span>
  )
}

/** A file name as the drop has it, in the identifier face, cut in the middle so its index and date survive. */
export function DecisionFileName({ name }: { name: string }): JSX.Element {
  return <MiddleTruncate text={name} tail={22} className="font-mono text-xs" />
}
