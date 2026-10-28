'use client'

import * as React from 'react'
import { Check } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useDelayedFlag } from '@/hooks/use-transient-flag'
import { cn } from '@/lib/utils'

export interface SaveButtonProps extends Omit<ButtonProps, 'children' | 'loading'> {
  /** The save is in flight. */
  busy: boolean
  /**
   * What is on screen is what is stored, because THIS session saved it. The
   * button then says so and stays where the reader's focus is, until an edit
   * makes it a Save again. Not set on a form nobody has saved yet.
   */
  saved: boolean
  /** The resting label („Speichern"). */
  children: string
  /** The label while the save runs („Wird gespeichert …"). */
  busyLabel: string
  /** The label once saved („Gespeichert"). */
  savedLabel: string
}

/**
 * A settings form's Save, which reports its own outcome.
 *
 * A success toast in the corner said "saved" about a form the reader was
 * looking at, two hands of distance from the button they had pressed, and
 * then went away: the control is where the eye already is, and the state
 * belongs on it. So the button turns into „Gespeichert" with a check and
 * stays that way while the fields hold what is stored. Failures still toast:
 * a transient action failure is what a toast is for (design language,
 * „Error").
 *
 * Busy is not disabled: while saving, and while it reads „Gespeichert", the
 * button is `aria-disabled` with the press swallowed, so it keeps the focus
 * the reader's press gave it (Chrome blurs a button the moment it turns
 * `disabled`). `disabled` stays for a Save there is nothing to do for yet.
 * The labels share one grid cell, so the width never moves, and the spinner
 * appears only after 150 ms. A polite status line announces the save to a
 * screen reader, which the toast used to do.
 */
export const SaveButton = React.forwardRef<HTMLButtonElement, SaveButtonProps>(
  ({ busy, saved, children, busyLabel, savedLabel, disabled, className, onClick, ...props }, ref) => {
    const showBusy = useDelayedFlag(busy)
    const state = showBusy ? 'busy' : saved && !busy ? 'saved' : 'idle'
    const inert = busy || saved
    const faces: Array<[typeof state, React.ReactNode, string]> = [
      ['idle', null, children],
      ['busy', <Spinner key="spinner" size="sm" aria-hidden="true" />, busyLabel],
      ['saved', <Check key="check" aria-hidden="true" />, savedLabel],
    ]
    return (
      <>
        <Button
          ref={ref}
          {...props}
          disabled={disabled && !inert}
          aria-disabled={inert || undefined}
          aria-busy={busy || undefined}
          data-state={state}
          className={cn('aria-disabled:cursor-default', className)}
          onClick={(event) => {
            if (inert) {
              event.preventDefault()
              return
            }
            onClick?.(event)
          }}
        >
          <span className="grid">
            {faces.map(([face, glyph, label]) => (
              <span
                key={face}
                aria-hidden={state !== face}
                className={cn(
                  'col-start-1 row-start-1 inline-flex items-center justify-center gap-2',
                  state !== face && 'invisible'
                )}
              >
                {glyph}
                {label}
              </span>
            ))}
          </span>
        </Button>
        <span className="sr-only" role="status">
          {state === 'saved' ? savedLabel : ''}
        </span>
      </>
    )
  }
)
SaveButton.displayName = 'SaveButton'
