'use client'

/**
 * A number with its unit, typed in place: `[ 20 ] cm`.
 *
 * The kit's `Input` is a text field; a quantity needs three things more, and
 * each is easy to get subtly wrong in a card:
 *
 *  - **The Austrian decimal comma.** `type="number"` rejects „0,035" in some
 *    browsers and reports it as blank in others. This is a text field with a
 *    decimal keyboard (`inputMode="decimal"`) read by `parseDecimalInput`, the
 *    product's one strict parse, so „0,035" and „0.035" are the same number and
 *    „0,0x" is an error, never a silent 0.
 *  - **The keyboard.** It is a `spinbutton`: ArrowUp and ArrowDown move by
 *    `step` (PageUp/PageDown by ten steps), Home and End go to the bounds, and
 *    a screen reader hears the value, the unit and the range.
 *  - **The touch floor.** The field is the kit's `Input`, 44px under a coarse
 *    pointer; the unit sits beside it as text, so a long unit („W/(m·K)")
 *    never covers the digits.
 *
 * It reports a number or `null` (blank, or not a number, or outside the
 * bounds) and says which by `aria-invalid`; what null MEANS is the caller's.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { useLocale } from '@/i18n'
import { formatDecimalInput, parseDecimalInput } from '@/lib/text/parse-decimal'
import { cn } from '@/lib/utils'

export interface QuantityInputProps {
  value: number | null
  onValueChange: (value: number | null) => void
  unit: string
  /** The accessible name: what the quantity is. */
  label: string
  min?: number | null
  max?: number | null
  step?: number | null
  /** A sentence under the field when the typed text is not an admissible number. */
  invalidMessage?: (reason: 'notANumber' | 'outOfRange') => string
  /** Shown in an empty field: what an empty value means („Wert fehlt"). */
  placeholder?: string
  /** Ids of text that describes the field further (its source, the reader's-assumption marker). */
  describedBy?: string
  className?: string
}

const decimalsOf = (step: number): number => {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

type Check = { value: number | null; error: 'notANumber' | 'outOfRange' | null }

function read(text: string, locale: string, min: number | null, max: number | null): Check {
  const parsed = parseDecimalInput(text, locale)
  if (parsed.status === 'blank') return { value: null, error: null }
  if (parsed.status === 'invalid') return { value: null, error: 'notANumber' }
  if ((min != null && parsed.value < min) || (max != null && parsed.value > max)) {
    return { value: null, error: 'outOfRange' }
  }
  return { value: parsed.value, error: null }
}

export function QuantityInput({
  value,
  onValueChange,
  unit,
  label,
  min = null,
  max = null,
  step = null,
  invalidMessage,
  placeholder,
  describedBy,
  className,
}: QuantityInputProps) {
  const { locale } = useLocale()
  const [text, setText] = useState(() => formatDecimalInput(value, locale))
  const lastReported = useRef<number | null>(value)
  const unitId = useId()
  const errorId = useId()

  // A value set from outside (a reset to the source) replaces the text; the
  // reader's own typing, already reported, does not echo back over it.
  useEffect(() => {
    if (Object.is(value, lastReported.current)) return
    lastReported.current = value
    setText(formatDecimalInput(value, locale))
  }, [value, locale])

  const check = read(text, locale, min, max)

  const commit = (next: string) => {
    setText(next)
    const result = read(next, locale, min, max)
    lastReported.current = result.value
    onValueChange(result.value)
  }

  const stepBy = (count: number) => {
    const increment = step ?? 1
    const base = check.value ?? value ?? min ?? 0
    let next = base + count * increment
    if (min != null) next = Math.max(min, next)
    if (max != null) next = Math.min(max, next)
    const rounded = Number(next.toFixed(Math.max(decimalsOf(increment), decimalsOf(base))))
    commit(formatDecimalInput(rounded, locale))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 }
    if (event.key in moves) {
      event.preventDefault()
      stepBy(moves[event.key])
    } else if (event.key === 'Home' && min != null) {
      event.preventDefault()
      commit(formatDecimalInput(min, locale))
    } else if (event.key === 'End' && max != null) {
      event.preventDefault()
      commit(formatDecimalInput(max, locale))
    }
  }

  const describers = [unitId, check.error ? errorId : null, describedBy].filter(Boolean).join(' ')

  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      <span className="inline-flex items-center gap-1.5">
        <Input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          role="spinbutton"
          aria-label={label}
          aria-valuenow={check.value ?? undefined}
          aria-valuemin={min ?? undefined}
          aria-valuemax={max ?? undefined}
          aria-valuetext={check.value == null ? undefined : `${formatDecimalInput(check.value, locale)} ${unit}`}
          aria-invalid={check.error ? true : undefined}
          aria-describedby={describers}
          value={text}
          placeholder={placeholder}
          onChange={(event) => commit(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-9 w-[6.5rem] px-2.5 text-right font-mono tabular-nums"
        />
        <span id={unitId} className="card-meta whitespace-nowrap text-muted-foreground">
          {unit}
        </span>
      </span>
      {check.error && invalidMessage && (
        <span id={errorId} role="alert" className="card-meta text-error">
          {invalidMessage(check.error)}
        </span>
      )}
    </span>
  )
}
