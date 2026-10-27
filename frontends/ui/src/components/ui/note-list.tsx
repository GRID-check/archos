import type { HTMLAttributes, JSX, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A short list of notes inside a popover: one line of text each, verbatim,
 * with a leading glyph and a muted meta line under it. Domain-free; what a
 * note is belongs to the caller (Piloti's memory chip is the first).
 *
 * Not `ItemList`: that is a bordered card of connected rows on a page, and a
 * popover is already the card. These rows wrap rather than truncate, because a
 * note shown to a reader as "what is now durable about your project" has to be
 * read whole.
 *
 * Bounded at 18rem and dissolved at the bottom edge (`scroll-fade-bottom`),
 * so a turn that wrote six long notes scrolls inside the popover instead of
 * pushing it off a phone's screen.
 */
export function NoteList({ className, ...props }: HTMLAttributes<HTMLUListElement>): JSX.Element {
  return (
    <ul
      data-slot="note-list"
      className={cn('scroll-fade-bottom max-h-72 divide-y overflow-y-auto', className)}
      {...props}
    />
  )
}

/** One note: the glyph, the text, and what it is under it. */
export function NoteRow({
  icon: Icon,
  meta,
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLLIElement>, 'children'> & {
  icon: LucideIcon
  /** The muted line under the note: its kind, where it came from, what it replaced. */
  meta?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <li data-slot="note-row" className={cn('flex gap-2.5 px-4 py-2.5', className)} {...props}>
      <Icon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm leading-snug">{children}</p>
        {meta ? <div className="text-muted-foreground mt-1 text-xs">{meta}</div> : null}
      </div>
    </li>
  )
}

/** The meta line's parts, separated by a middle dot the screen reader skips. */
export function NoteMeta({ parts }: { parts: ReactNode[] }): JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {parts.map((part, index) => (
        // Positional on purpose: the parts are a fixed sequence the caller
        // builds per row, never reordered.
        <span key={index} className="inline-flex items-center gap-1">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </p>
  )
}

/** A popover's own title line and its closing hint, the two edges of the panel. */
export function NotePanelTitle({
  icon: Icon,
  id,
  children,
}: {
  icon: LucideIcon
  id?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div data-slot="note-panel-title" className="flex items-center gap-2 border-b px-4 py-3">
      <Icon className="text-info size-4 shrink-0" aria-hidden="true" />
      <p id={id} className="text-sm font-medium">
        {children}
      </p>
    </div>
  )
}

/** A meta part that must be read before the rest of the line (a correction). */
export function NoteEmphasis({ children }: { children: ReactNode }): JSX.Element {
  return <span className="text-foreground font-medium">{children}</span>
}

/**
 * The note this one replaced, quoted and struck through. `<del>` so a screen
 * reader that announces deletions says so, and the strike is never the only
 * signal: the caller's label („Ersetzt:") says it in words.
 */
export function NoteReplaced({
  label,
  children,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & { label: ReactNode }): JSX.Element {
  return (
    <p className="mt-1" {...props}>
      {label} <del>{children}</del>
    </p>
  )
}

export function NotePanelHint({ id, children }: { id?: string; children: ReactNode }): JSX.Element {
  return (
    <div data-slot="note-panel-hint" className="border-t px-4 py-2.5">
      <p id={id} className="text-muted-foreground text-xs leading-relaxed">
        {children}
      </p>
    </div>
  )
}
