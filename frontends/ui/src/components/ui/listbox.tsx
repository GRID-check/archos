import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Listbox — the suggestions under a typing field (an ARIA combobox's popup),
 * drawn in the flow of the form instead of in a floating layer.
 *
 * Inline on purpose. The one caller lives in a dialog, and a portalled popover
 * there fights the dialog over focus, outside presses and Escape. A list that
 * simply opens under the field has none of that, and it pushes the rest of the
 * form down for as long as it is open, which is the honest cost of a small
 * dialog. Focus never leaves the field: the field owns the keyboard and names
 * the active option with `aria-activedescendant`, this only paints.
 */
export function Listbox({ className, ...props }: React.ComponentProps<'ul'>): React.JSX.Element {
  return (
    <ul
      role="listbox"
      data-slot="listbox"
      className={cn('bg-popover text-popover-foreground border-border max-h-64 overflow-y-auto rounded-lg border p-1 shadow-xs', className)}
      {...props}
    />
  )
}

export interface ListboxOptionProps extends Omit<React.ComponentProps<'li'>, 'onSelect'> {
  /** The option the keyboard is on. */
  active?: boolean
  selected?: boolean
  /** Fired on pointer press, which keeps focus in the field (a click would blur it first). */
  onChoose?: () => void
}

export function ListboxOption({
  active = false,
  selected = false,
  onChoose,
  className,
  onMouseDown,
  ...props
}: ListboxOptionProps): React.JSX.Element {
  return (
    <li
      role="option"
      aria-selected={selected}
      data-slot="listbox-option"
      data-active={active || undefined}
      className={cn(
        'flex min-h-9 cursor-pointer flex-col justify-center rounded-md px-2.5 py-1.5 text-sm pointer-coarse:min-h-11',
        'data-[active]:bg-accent data-[active]:text-accent-foreground hover:bg-accent',
        className
      )}
      onMouseDown={(event) => {
        // Keeps the field focused: its blur is what closes the list.
        event.preventDefault()
        onMouseDown?.(event)
        onChoose?.()
      }}
      {...props}
    />
  )
}
