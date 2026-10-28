'use client'

import * as React from 'react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StackedLabel } from '@/components/ui/stacked-label'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { cn } from '@/lib/utils'

export interface BusyButtonProps extends Omit<ButtonProps, 'loading' | 'children'> {
  /** This control's own request is in flight. */
  busy?: boolean
  /**
   * A request is in flight somewhere on the page and this control must wait.
   * It swallows the press like a busy one but keeps its label; only a wait
   * past the reveal delay dims it.
   */
  blocked?: boolean
  /** The resting label. */
  children: string
  /** The label while this control's request is in flight („Wird gespeichert …"). */
  busyLabel: string
  /** A leading glyph; the spinner takes its place once the wait is long enough to notice. */
  icon?: React.ReactNode
}

/**
 * A button that works without ever being `disabled`: the pattern the proposal
 * receipts wrote out by hand (docs/design/design-language.md, „Busy is not
 * disabled"). While a request is in flight the control keeps its focus
 * (`aria-disabled` plus a guard in the handler, because Chrome blurs a button
 * the moment it becomes `disabled`) and its width (`StackedLabel` holds the
 * longer of its two labels), and the busy look appears only once the wait has
 * lasted 150 ms (`useDelayedFlag`): below that the press is the feedback.
 *
 * `disabled` stays available for what cannot be done at all (an answer not
 * typed yet), which is not a state a focused control moves into by being
 * pressed.
 */
export const BusyButton = React.forwardRef<HTMLButtonElement, BusyButtonProps>(
  ({ busy = false, blocked = false, busyLabel, icon, children, className, onClick, ...props }, ref) => {
    const showBusy = useDelayedFlag(busy)
    const dimmed = useDelayedFlag(blocked && !busy)
    const waiting = busy || blocked
    return (
      <Button
        ref={ref}
        {...props}
        aria-disabled={waiting || undefined}
        aria-busy={busy || undefined}
        data-busy={showBusy || undefined}
        className={cn('aria-disabled:cursor-default', dimmed && 'opacity-60', className)}
        onClick={(event) => {
          if (waiting) {
            event.preventDefault()
            return
          }
          onClick?.(event)
        }}
      >
        {showBusy ? <Spinner size="sm" aria-hidden="true" className={icon ? undefined : 'hidden'} /> : icon}
        <StackedLabel busy={showBusy} idle={children} working={busyLabel} className={icon ? 'text-start' : undefined} />
      </Button>
    )
  }
)
BusyButton.displayName = 'BusyButton'
