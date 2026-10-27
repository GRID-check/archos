'use client'

/**
 * SuggestInput — a text field that offers values as it is typed into, each
 * with how often it occurs: the WAI-ARIA combobox with list autocomplete.
 * Focus stays in the field; ↑ ↓ move the active option
 * (`aria-activedescendant`), Enter takes it, Escape closes the list and
 * nothing else. Nothing is active until an arrow is pressed, so Enter on what
 * was typed keeps meaning what it meant without suggestions: take the text.
 *
 * The list floats under the field in its own subtree rather than a portal
 * (`Listbox`, whose header says why), so it works inside a sheet or a rail.
 * Knows no domain: where the options come from, and what taking one does, is
 * the caller's.
 */

import * as React from 'react'

import { Input } from '@/components/ui/input'
import { Listbox, ListboxOption } from '@/components/ui/listbox'

export interface SuggestOption {
  /** What taking it hands back; unique within the list. */
  value: string
  label: string
  /** How many hold it, shown at the end of the line. */
  count?: number
  /** A second, quiet line: what kind of value it is. */
  hint?: string
}

export interface SuggestInputProps extends Omit<
  React.ComponentProps<typeof Input>,
  'value' | 'onChange' | 'onKeyDown' | 'onFocus' | 'onBlur' | 'role'
> {
  value: string
  onValueChange: (value: string) => void
  options: readonly SuggestOption[]
  /** The option was taken, by Enter on it or a press. */
  onPick: (option: SuggestOption, index: number) => void
  /** Enter with no option active, or the field let go: take what was typed. */
  onCommit?: () => void
  /** Whether letting go of the field commits, as Enter does. Default true; false where a button beside it adds. */
  commitOnBlur?: boolean
  /** The field took or lost focus (the caller asks for options only while it has it). */
  onFocusChange?: (focused: boolean) => void
  /** The list's accessible name. */
  listLabel: string
  'data-testid'?: string
}

export function SuggestInput({
  value,
  onValueChange,
  options,
  onPick,
  onCommit,
  commitOnBlur = true,
  onFocusChange,
  listLabel,
  className,
  id,
  'data-testid': testId,
  ...props
}: SuggestInputProps): React.JSX.Element {
  const generated = React.useId()
  const fieldId = id ?? `${generated}-input`
  const listId = `${generated}-list`
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  // A new list starts with nothing active: what the arrows were on may be gone.
  const [listed, setListed] = React.useState(options)
  if (listed !== options) {
    setListed(options)
    setActive(-1)
  }
  const shown = open && options.length > 0

  const pick = (index: number): void => {
    const option = options[index]
    if (!option) return
    setOpen(false)
    setActive(-1)
    onPick(option, index)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      if (!shown) return
      // The list closes; the sheet or dialog around it stays.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return
      event.preventDefault()
      setOpen(true)
      const count = options.length
      setActive((index) =>
        event.key === 'ArrowDown' ? (index + 1) % count : index <= 0 ? count - 1 : index - 1
      )
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (shown && active >= 0) pick(active)
      else onCommit?.()
    }
  }

  return (
    <div className="relative" data-slot="suggest-input">
      <Input
        {...props}
        id={fieldId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        className={className}
        onChange={(event) => {
          setOpen(true)
          onValueChange(event.target.value)
        }}
        onFocus={() => {
          setOpen(true)
          onFocusChange?.(true)
        }}
        onBlur={() => {
          setOpen(false)
          setActive(-1)
          onFocusChange?.(false)
          if (commitOnBlur) onCommit?.()
        }}
        onKeyDown={onKeyDown}
        data-testid={testId}
      />
      {shown ? (
        <Listbox
          id={listId}
          aria-label={listLabel}
          className="absolute inset-x-0 top-full z-20 mt-1 shadow-lg"
          data-testid={testId ? `${testId}-options` : undefined}
        >
          {options.map((option, index) => (
            <ListboxOption
              key={option.value}
              id={`${listId}-${index}`}
              active={index === active}
              onChoose={() => pick(index)}
              className="flex-row items-start gap-2"
              data-testid={testId ? `${testId}-option` : undefined}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-words">{option.label}</span>
                {option.hint ? (
                  <span className="text-muted-foreground text-xs">{option.hint}</span>
                ) : null}
              </span>
              {option.count !== undefined ? (
                <span className="text-muted-foreground shrink-0 text-xs leading-5 tabular-nums">
                  {option.count}
                </span>
              ) : null}
            </ListboxOption>
          ))}
        </Listbox>
      ) : null}
    </div>
  )
}
