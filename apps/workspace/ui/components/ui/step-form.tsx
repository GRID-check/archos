'use client'

/**
 * The two pieces every stepped form in this product wears beside `Stepper`:
 * the heading a step asks its one question in, and the one disclosure that
 * holds everything most people never touch.
 *
 * Lifted out of the schedule wizard, where they were designed, when the skill
 * builder became a stepped form too. Two wizards writing their own heading and
 * their own „Erweitert" is two of each drifting on the first token retune —
 * and the disclosure in particular carries a RULE, not just a shape (below),
 * which a second copy would quietly stop enforcing.
 */

import type { JSX } from 'react'
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { cn } from '@/lib/utils'

/** The heading every step wears: one question, one sentence under it. */
export function StepHeading({ title, hint }: { title: string; hint: string }): JSX.Element {
  return (
    <div className="mb-4">
      <h2 className="text-foreground text-lg font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{hint}</p>
    </div>
  )
}

/**
 * The one disclosure a step gets, shut by default.
 *
 * Progressive disclosure done as a RULE rather than case by case: if a control
 * is not needed by most of whatever this form makes, it goes behind this, and
 * the label says what is inside so nobody has to open it to find out. The
 * summary on the trigger is how a reader knows something in there is already
 * set — an "Erweitert" that quietly holds three of your answers is a trap.
 */
export function Advanced({
  label,
  summary,
  children,
  'data-testid': testId = 'wizard-advanced',
}: {
  label: string
  /** What is already set inside, or null when everything is at its default. */
  summary: string | null
  children: ReactNode
  'data-testid'?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-border mt-5 border-t pt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          // The house press and ring. `origin-left`: the trigger is a full-width
          // row whose content sits at its start, so the dip gathers toward the
          // chevron instead of pulling the label in from both ends.
          className={cn(
            'text-muted-foreground hover:text-foreground flex w-full origin-left items-center gap-2 rounded-control text-sm outline-none',
            PRESSABLE,
            FOCUS_RING
          )}
          data-testid={testId}
        >
          <ChevronDown
            className={cn(
              'size-4 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden
          />
          {label}
          {summary && !open && (
            <span className="text-muted-foreground/80 min-w-0 truncate text-xs">· {summary}</span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="duration-base ease-out motion-reduce:animate-none">
        <div className="space-y-4 pt-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
