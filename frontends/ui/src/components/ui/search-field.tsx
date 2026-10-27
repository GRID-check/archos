'use client'

import type { JSX } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react'
import { Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'

export interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  clearLabel?: string
  /** Called instead of `onChange('')` when the clear control is pressed. */
  onClear?: () => void
  className?: string
  inputClassName?: string
  clearClassName?: string
  /**
   * Default `text` so existing `role="textbox"` queries keep working
   * (DataToolbar, admin filters). Pass `search` only when the field is a
   * standalone search landmark.
   */
  type?: 'search' | 'text'
  inputRef?: Ref<HTMLInputElement>
  /** Optional control after the field (a run / submit button). */
  trailing?: ReactNode
  /**
   * Shown inside the field's end while it is empty: the shortcut that focuses
   * it (`<KbdGroup>`). Gives way to the clear control once there is a value.
   */
  hint?: ReactNode
  /** Keys the field handles itself (Escape, the arrows over a result list). */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  /**
   * The field drives a result list from the keyboard (WAI-ARIA combobox
   * pattern, list autocomplete): it stays focused while ↑ ↓ move an active
   * option, and a screen reader follows that option through
   * `aria-activedescendant`. Absent, the field is a plain text or search box.
   */
  combobox?: SearchFieldCombobox
}

export interface SearchFieldCombobox {
  /** The id(s) of the listbox(es) or grid the field drives, space-separated. */
  controls: string
  /** Whether results are showing for the field to walk. */
  expanded: boolean
  /** The id of the option the arrow keys are on, if any. */
  activeDescendant?: string | null
}

/**
 * Magnifier + Input + optional clear. Every product search field is this
 * molecule — not a one-off `relative` wrapper next to `DataToolbar`.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
  onClear,
  className,
  inputClassName,
  clearClassName,
  type = 'text',
  inputRef,
  trailing,
  hint,
  onKeyDown,
  combobox,
}: SearchFieldProps): JSX.Element {
  const canClear = Boolean(clearLabel)
  const hasValue = Boolean(value)

  const field = (
    <InputGroup>
      <InputGroupAddon>
        <Search aria-hidden />
      </InputGroupAddon>
      <Input
        ref={inputRef}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        {...(combobox
          ? {
              role: 'combobox',
              'aria-autocomplete': 'list' as const,
              'aria-controls': combobox.controls || undefined,
              'aria-expanded': combobox.expanded,
              'aria-activedescendant': combobox.activeDescendant ?? undefined,
            }
          : {})}
        // THE SOFT KEYBOARD IS PART OF THIS CONTROL, and until now nothing in the
        // app told it so — `enterKeyHint` appeared nowhere in `src/`.
        //
        // `enterKeyHint="search"` relabels the phone's action key from the
        // generic return arrow to "Search"/"Suchen". Every field built on this
        // molecule submits on Enter (the Files browser and the Archiv library run
        // a semantic search off it), so the key already did this — it just would
        // not say so, and a key that does not say what it does is one a reader
        // has to try.
        //
        // The three off-switches matter as much. A phone capitalises the first
        // letter of a field and autocorrects as you type, which is right for
        // prose and wrong for every query typed here: these search filenames,
        // norm numbers and people. "oib" became "Oib", "§" phrases were
        // "corrected" into words, and the result set silently disagreed with what
        // the reader thought they had typed. Search matches strings; the keyboard
        // must not edit them on the way in.
        enterKeyHint="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          'h-9 pl-8 [&::-webkit-search-cancel-button]:hidden',
          // Reserve the clear gutter even when empty so typing does not shift text.
          // Under a finger the clear grows to 44px (the Button's own
          // `pointer-coarse:size-11`), so the gutter grows with it and the end
          // of a long query never runs under the X.
          canClear && 'pr-8 pointer-coarse:pr-11',
          hint && !hasValue && 'sm:pr-20',
          inputClassName,
        )}
      />
      {hint && !hasValue ? (
        <InputGroupAddon align="end" className="right-2 max-sm:hidden pointer-coarse:hidden" aria-hidden>
          {hint}
        </InputGroupAddon>
      ) : null}
      {canClear ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          tabIndex={hasValue ? undefined : -1}
          aria-hidden={!hasValue}
          className={cn(
            // No transition of its own: the Button's list already eases opacity
            // on --motion-quick, and replacing it dropped the press dip.
            'absolute right-0.5 top-1/2 size-8 -translate-y-1/2 text-muted-foreground',
            hasValue ? 'opacity-100' : 'pointer-events-none opacity-0',
            clearClassName,
          )}
          aria-label={clearLabel}
          onClick={() => {
            if (!hasValue) return
            if (onClear) {
              onClear()
            } else {
              onChange('')
            }
          }}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </InputGroup>
  )

  if (!trailing) {
    return className ? <div className={className}>{field}</div> : field
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      {field}
      <div className="shrink-0">{trailing}</div>
    </div>
  )
}
