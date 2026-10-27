'use client'

/**
 * A day, typed in the page's locale and held as `YYYY-MM-DD`.
 *
 * Not `<input type="date">`: Chrome draws its segments in the browser's
 * language, not the page's, so a German page in an English Chrome asked for
 * `mm/dd/yyyy` (the search's Planstand did). Here the order and the separator
 * come from `Intl` in the page's locale (`27.10.2026`, `10/27/2026`), and the
 * placeholder names the parts in the reader's words (`TT.MM.JJJJ`).
 *
 * The value is committed on Enter or blur, as the other typed filters are: a
 * day half typed is no question yet. Empty commits `''`; a day that does not
 * exist, or lies outside `min`/`max`, is marked invalid and not sent.
 * A two-digit year is this century's.
 */

import { useState, type JSX, type KeyboardEvent } from 'react'

import { Input } from '@/components/ui/input'

type Part = 'day' | 'month' | 'year'

export interface DateInputProps {
  /** `YYYY-MM-DD`, or `''` for none. */
  value: string
  onChange: (value: string) => void
  locale: string
  /** How the placeholder names each part: `{ day: 'TT', month: 'MM', year: 'JJJJ' }`. */
  tokens: Record<Part, string>
  /** Before the pattern in the placeholder, where no label sits beside the field: „Von“ → „Von TT.MM.JJJJ“. */
  placeholderPrefix?: string
  id?: string
  'aria-label'?: string
  /** Inclusive bounds, `YYYY-MM-DD`. */
  min?: string
  max?: string
  'data-testid'?: string
}

interface Pattern {
  order: Part[]
  separator: string
}

/** The order of day, month and year and the separator between them, as the locale writes a date. */
export function datePattern(locale: string): Pattern {
  const parts = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).formatToParts(
    new Date(Date.UTC(2026, 10, 27))
  )
  const order = parts.flatMap((part) => (part.type === 'day' || part.type === 'month' || part.type === 'year' ? [part.type] : []))
  const separator = parts.find((part) => part.type === 'literal')?.value ?? '.'
  return { order: order.length === 3 ? order : ['day', 'month', 'year'], separator }
}

/** `YYYY-MM-DD` as the locale writes it; `''` for anything else. */
export function formatDateValue(value: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return ''
  const { order, separator } = datePattern(locale)
  const byPart: Record<Part, string> = { year: match[1], month: match[2], day: match[3] }
  return order.map((part) => byPart[part]).join(separator)
}

/** What the reader typed, as `YYYY-MM-DD`; `''` for nothing; null when it is no day. */
export function parseDateText(text: string, locale: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const numbers = trimmed.split(/\D+/).filter(Boolean)
  if (numbers.length !== 3) return null
  const { order } = datePattern(locale)
  const byPart = Object.fromEntries(order.map((part, index) => [part, Number(numbers[index])])) as Record<Part, number>
  const year = numbers[order.indexOf('year')].length <= 2 ? 2000 + byPart.year : byPart.year
  const date = new Date(Date.UTC(year, byPart.month - 1, byPart.day))
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== byPart.month - 1 || date.getUTCDate() !== byPart.day) return null
  return date.toISOString().slice(0, 10)
}

export function DateInput(props: DateInputProps): JSX.Element {
  // Keyed to the committed value, so a change from outside (a chip removed, Back) resets the draft.
  return <DateInputField key={props.value} {...props} />
}

function DateInputField({ value, onChange, locale, tokens, placeholderPrefix, id, min, max, ...rest }: DateInputProps): JSX.Element {
  const [draft, setDraft] = useState(() => formatDateValue(value, locale))
  const [invalid, setInvalid] = useState(false)
  const { order, separator } = datePattern(locale)
  const commit = (): void => {
    const parsed = parseDateText(draft, locale)
    const outside = parsed !== null && parsed !== '' && ((min !== undefined && parsed < min) || (max !== undefined && parsed > max))
    if (parsed === null || outside) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (parsed !== value) onChange(parsed)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
  }
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="off"
      placeholder={[placeholderPrefix, order.map((part) => tokens[part]).join(separator)].filter(Boolean).join(' ')}
      value={draft}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        setDraft(event.target.value)
        if (invalid) setInvalid(false)
      }}
      onBlur={commit}
      onKeyDown={onKeyDown}
      {...rest}
    />
  )
}
