'use client'

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type JSX } from 'react'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from './focus-ring'
import { PRESSABLE } from './press'
import { PilotiGlyph } from './piloti-glyph'

/**
 * NewMark — the quiet „neu" beside a folder that a move would create. A dashed
 * edge in the strongest hairline and muted ink, no fill: it qualifies the name
 * beside it and must not outshout it. No colour either, because chroma in this
 * product says where a source comes from (`grid-design-language.md`), and a
 * green „neu" would read as „Projekt".
 */
export function NewMark({ className, ...props }: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return (
    <span
      data-slot="new-mark"
      className={cn(
        'border-strong text-muted-foreground inline-flex shrink-0 items-center rounded-sm border border-dashed px-1 text-[10px] font-medium leading-[14px] tracking-[0.02em] whitespace-nowrap',
        className
      )}
      {...props}
    />
  )
}

export interface FilingChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Where the suggestion would put the thing: the folder's own name, never its whole path. */
  target: string
  /** „neu", when the move creates the folder. */
  newLabel?: string
}

/**
 * FilingChip — Piloti's suggestion of where something belongs, as a pill that
 * opens the decision: its glyph, „→ Bescheide", and „neu" for a folder the
 * move creates.
 *
 * Calm by default, because after a batch upload ten of these may sit on one
 * screen: the card's own surface, no fill colour of its own, a DASHED edge in
 * the strongest hairline that says „not yet". The edge turns solid on hover
 * and while the popover it opens is open (`aria-expanded`).
 *
 * It never makes the line it sits in taller: 24px tall with `-my-1`, so its
 * margin box is the 16px of a line of `text-xs`, and a card footer or a list
 * row with a chip is exactly as tall as one without. The glyph and „neu" never
 * shrink; only the folder's name ellipsizes, and the full path is in the
 * popover. It fades in (opacity only) and holds still otherwise.
 *
 * A button with `aria-haspopup="dialog"`, meant to be a Radix trigger
 * (`PopoverTrigger asChild`), so it forwards its ref and every prop.
 */
export const FilingChip = forwardRef<HTMLButtonElement, FilingChipProps>(function FilingChip(
  { target, newLabel, className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-haspopup="dialog"
      data-slot="filing-chip"
      className={cn(
        'border-strong bg-card text-foreground -my-1 inline-flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-full border border-dashed pl-[3px] pr-2 text-[11px] font-medium leading-none',
        'hover:bg-accent aria-expanded:bg-accent hover:border-solid aria-expanded:border-solid',
        PRESSABLE,
        'animate-in fade-in-0 motion-reduce:animate-none',
        'touch-target outline-none',
        FOCUS_RING,
        className
      )}
      {...props}
    >
      <PilotiGlyph size="xs" className="size-4" />
      <span className="min-w-0 truncate">
        <span aria-hidden>→ </span>
        {target}
      </span>
      {newLabel && <NewMark>{newLabel}</NewMark>}
    </button>
  )
})
