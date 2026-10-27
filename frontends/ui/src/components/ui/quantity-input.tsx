'use client'

/**
 * A number with its unit, typed in place: `[ 20 ] cm`.
 *
 * The kit's `Input` is a text field; a quantity needs four things more, and
 * each is easy to get subtly wrong in a card:
 *
 *  - **The Austrian decimal comma.** `type="number"` rejects „0,035" in some
 *    browsers and reports it as blank in others. This is a text field with a
 *    decimal keyboard (`inputMode="decimal"`) read by `parseDecimalInput`, the
 *    product's one strict parse, so „0,035" and „0.035" are the same number and
 *    „0,0x" is an error, never a silent 0.
 *  - **Typing is not deciding.** Typing „19" passes through „1", and a field
 *    that reported every keystroke would announce „1 is out of range" and flip
 *    a verdict the reader never meant. The typed value is reported once the
 *    reader pauses (`settleMs`), leaves the field or presses Enter; an error is
 *    shown and announced (politely) only then. The arrow keys report at once:
 *    each press is a decision.
 *  - **The keyboard.** It is a `spinbutton`: ArrowUp and ArrowDown move by
 *    `step` (PageUp/PageDown by ten steps), Home and End go to the bounds, and
 *    a screen reader hears the value, the unit and the range.
 *  - **The touch floor.** The field is the kit's `Input`, 44px under a coarse
 *    pointer; the unit sits beside it as text, so a long unit („W/(m·K)")
 *    never covers the digits.
 *
 * It reports a number, or `null` with the reason (`QuantityIssue`): blank is
 * no issue, and what null MEANS is the caller's.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { useLocale } from '@/i18n'
import { formatDecimalInput, parseDecimalInput } from '@/lib/text/parse-decimal'
import { cn } from '@/lib/utils'

/** Why a typed text is not a value: not a number, outside the bounds, or 0 where 0 is impossible. */
export type QuantityIssue = 'notANumber' | 'outOfRange' | 'zero'

export interface QuantityInputProps {
  value: number | null
  onValueChange: (value: number | null, issue: QuantityIssue | null) => void
  unit: string
  /** The accessible name: what the quantity is. */
  label: string
  min?: number | null
  max?: number | null
  step?: number | null
  /** `min` is exclusive at 0: a λ or a floor area of 0 is not a value but a division by zero. */
  positive?: boolean
  /** Shown in an empty field: what an empty value means. */
  placeholder?: string
  /** A sentence under the field when the typed text is not an admissible number. */
  invalidMessage?: (issue: QuantityIssue) => string
  /** Ids of text that describes the field further (its source, the reader's-assumption marker). */
  describedBy?: string
  /** How long after the last keystroke the typed value is reported. */
  settleMs?: number
  className?: string
}

const decimalsOf = (step: number): number => {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

type Reading = { value: number | null; issue: QuantityIssue | null }

function read(text: string, locale: string, min: number | null, max: number | null, positive: boolean): Reading {
  const parsed = parseDecimalInput(text, locale)
  if (parsed.status === 'blank') return { value: null, issue: null }
  if (parsed.status === 'invalid') return { value: null, issue: 'notANumber' }
  if (positive && parsed.value === 0) return { value: null, issue: 'zero' }
  if ((min != null && parsed.value < min) || (max != null && parsed.value > max)) {
    return { value: null, issue: 'outOfRange' }
  }
  return { value: parsed.value, issue: null }
}

export function QuantityInput({
  value,
  onValueChange,
  unit,
  label,
  min = null,
  max = null,
  step = null,
  positive = false,
  placeholder,
  invalidMessage,
  describedBy,
  settleMs = 450,
  className,
}: QuantityInputProps) {
  const { locale } = useLocale()
  const [text, setText] = useState(() => formatDecimalInput(value, locale))
  // The issue SHOWN: set when a typed text is reported, never while typing.
  const [shown, setShown] = useState<QuantityIssue | null>(null)
  const lastReported = useRef<number | null>(value)
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unitId = useId()
  const errorId = useId()

  const report = (next: string) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
    const reading = read(next, locale, min, max, positive)
    setShown(reading.issue)
    lastReported.current = reading.value
    onValueChange(reading.value, reading.issue)
  }

  // A value set from outside (a reset to the source) replaces the text; the
  // reader's own typing, already reported, does not echo back over it.
  useEffect(() => {
    if (Object.is(value, lastReported.current) || pending.current != null) return
    lastReported.current = value
    setText(formatDecimalInput(value, locale))
    setShown(null)
  }, [value, locale])

  // A typed value not yet reported is reported when the field goes away (a tab
  // switch), not lost. The ref holds the latest `report` for the cleanup.
  const reportRef = useRef(report)
  reportRef.current = report
  useEffect(
    () => () => {
      if (pending.current != null) reportRef.current(pending.current)
    },
    []
  )

  const type = (next: string) => {
    setText(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => report(next), settleMs)
  }

  const commit = (next: string) => {
    setText(next)
    report(next)
  }

  const stepBy = (count: number) => {
    const increment = step ?? 1
    const current = read(text, locale, null, null, false).value
    const base = current ?? value ?? min ?? 0
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
    } else if (event.key === 'Enter') {
      if (pending.current != null) report(pending.current)
    } else if (event.key === 'Home' && min != null) {
      event.preventDefault()
      commit(formatDecimalInput(min, locale))
    } else if (event.key === 'End' && max != null) {
      event.preventDefault()
      commit(formatDecimalInput(max, locale))
    }
  }

  const current = read(text, locale, min, max, positive)
  const describers = [unitId, shown ? errorId : null, describedBy].filter(Boolean).join(' ')

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
          aria-valuenow={current.value ?? undefined}
          aria-valuemin={min ?? undefined}
          aria-valuemax={max ?? undefined}
          aria-valuetext={current.value == null ? undefined : `${formatDecimalInput(current.value, locale)} ${unit}`}
          aria-invalid={shown ? true : undefined}
          aria-describedby={describers}
          placeholder={placeholder}
          value={text}
          onChange={(event) => type(event.target.value)}
          onBlur={() => {
            if (pending.current != null) report(pending.current)
          }}
          onKeyDown={onKeyDown}
          className="h-9 w-[6.5rem] px-2.5 text-right font-mono tabular-nums"
        />
        <span id={unitId} className="card-meta whitespace-nowrap text-muted-foreground">
          {unit}
        </span>
      </span>
      {/* Polite, and only once the reader has paused or left the field: an
          error announced on every keystroke is noise. */}
      <span id={errorId} role="status" className="card-meta text-error empty:hidden">
        {shown && invalidMessage ? invalidMessage(shown) : ''}
      </span>
    </span>
  )
}
