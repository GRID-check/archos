'use client'

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type JSX, type ReactNode, type SyntheticEvent } from 'react'
import { cn } from '@/lib/utils'
import { Button, type ButtonProps } from './button'
import { PilotiGlyph } from './piloti-glyph'
import { PopoverContent } from './popover'

/**
 * The material of Piloti's suggestions that a person answers: the quiet panel
 * that lists them one line each, the popover one of them opens, and the parts
 * both are made of (the reason, a note, the answer). Domain-free: what is
 * suggested is the caller's.
 *
 * Quiet on purpose. The panel is the card surface with one hairline and no
 * shadow, so above a grid it reads as part of the page and not as a dialog
 * that wants an answer first.
 */

/**
 * The panel: card surface, one hairline, no shadow, its lines inset by 6px.
 * `grid-cols-1` is `minmax(0, 1fr)`: without it the implicit `auto` column
 * grows to its widest unbreakable line, and a long file name pushed the panel
 * past a phone's edge.
 */
export function SuggestionPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      role="group"
      data-slot="suggestion-panel"
      className={cn('bg-card grid grid-cols-1 gap-0.5 rounded-xl border p-1.5', className)}
      {...props}
    />
  )
}

/** Its header: Piloti's glyph and one line saying what is suggested. */
export function SuggestionPanelHeader({ id, children }: { id?: string; children: ReactNode }): JSX.Element {
  return (
    <div data-slot="suggestion-panel-header" className="flex items-center gap-2 px-2 pb-1 pt-1.5">
      <PilotiGlyph size="xs" className="size-4" />
      <p id={id} className="text-foreground min-w-0 text-xs font-medium">
        {children}
      </p>
    </div>
  )
}

/**
 * One line: what it concerns on the left, the answer on the right. The answer
 * wraps under the text where the line is narrow; the text keeps 14rem first.
 * The line fills while it is `active` (the caller's hover or focus), so the
 * reader sees which line the things lit elsewhere belong to.
 */
export function SuggestionPanelLine({
  active = false,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { active?: boolean }): JSX.Element {
  return (
    <div
      data-slot="suggestion-panel-line"
      data-active={active || undefined}
      className={cn(
        'data-[active]:bg-accent flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-2 py-1.5 text-xs',
        'transition-colors duration-snap ease-out motion-reduce:transition-none',
        className
      )}
      {...props}
    />
  )
}

/**
 * The line's subject: a name that is never cut (it wraps, even inside a long
 * word), what qualifies it, a muted count, and an optional muted detail line
 * under them that may truncate (`detail`, with its full text in `detailTitle`).
 */
export function SuggestionPanelSubject({
  name,
  mark,
  count,
  detail,
  detailTitle,
}: {
  name: ReactNode
  mark?: ReactNode
  count?: ReactNode
  detail?: ReactNode
  detailTitle?: string
}): JSX.Element {
  return (
    <div className="min-w-0 flex-[1_1_14rem]">
      <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-foreground min-w-0 font-medium [overflow-wrap:anywhere]">{name}</span>
        {mark}
        {count !== undefined && <span className="text-muted-foreground whitespace-nowrap tabular-nums">{count}</span>}
      </p>
      {detail && (
        <p className="text-muted-foreground mt-0.5 truncate" title={detailTitle}>
          {detail}
        </p>
      )}
    </div>
  )
}

/** The answer: its buttons right-aligned, wrapping among themselves where there is no room. */
export function SuggestionActions({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1', className)} {...props} />
}

/** A button of the answer: the compact 28px of a dense line, the kit's variants. */
export const SuggestionButton = forwardRef<HTMLButtonElement, ButtonProps>(function SuggestionButton(
  { className, size = 'sm', type = 'button', ...props },
  ref
) {
  return <Button ref={ref} type={type} size={size} className={cn('h-7 px-2.5', className)} {...props} />
})

/** Why: up to three lines of muted text, the rest behind an ellipsis. */
export function SuggestionReason({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cn('text-muted-foreground line-clamp-3 text-xs leading-snug', className)} {...props} />
}

/** A short sentence beside the answer or in its place: an outcome, who may decide, an error. */
export function SuggestionNote({
  tone = 'muted',
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & { tone?: 'muted' | 'default' | 'error' }): JSX.Element {
  return (
    <p
      className={cn(
        'text-xs leading-snug',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'default' && 'text-foreground',
        tone === 'error' && 'text-destructive',
        className
      )}
      {...props}
    />
  )
}

const stop = (event: SyntheticEvent) => event.stopPropagation()

/**
 * The popover a suggestion chip opens: the kit's `PopoverContent`, sized for a
 * decision (18rem, never wider than the screen) with its parts 10px apart.
 *
 * React carries an event out of a portal along the component tree, so a click
 * in here would reach the card or the row the chip sits on and open the file.
 * Nothing inside a decision is meant for what is behind it: clicks, presses,
 * keys and the context menu stop here.
 */
export const SuggestionPopoverContent = forwardRef<
  ElementRef<typeof PopoverContent>,
  ComponentPropsWithoutRef<typeof PopoverContent>
>(function SuggestionPopoverContent({ className, align = 'start', ...props }, ref) {
  return (
    <PopoverContent
      ref={ref}
      align={align}
      collisionPadding={16}
      className={cn('grid w-72 max-w-[calc(100vw-2rem)] grid-cols-1 gap-2.5 p-3 text-xs', className)}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
      onContextMenu={stop}
      {...props}
    />
  )
})
