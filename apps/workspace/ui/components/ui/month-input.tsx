'use client'

/**
 * A month: two selects, Monat and Jahr, holding `YYYY-MM`.
 *
 * Not `<input type="month">`: desktop Safari has none and shows a bare text
 * field expecting `2026-03`, and Chrome names the months in the operating
 * system's language rather than the page's. Month names come from `Intl` in
 * the page's locale. The value is reported once both halves are chosen; a
 * clearable input reports `''` when cleared.
 */

import { useEffect, useMemo, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface MonthInputProps {
  /** `YYYY-MM`, or `''` for none. */
  value: string
  onChange: (value: string) => void
  locale: string
  /** Id of the month select, for a `FieldLabel htmlFor`. */
  id?: string
  monthLabel: string
  yearLabel: string
  /** Shown on an unset half. */
  placeholder?: { month: string; year: string }
  /** Offers a clear button, labelled so. */
  clearLabel?: string
  /** The years offered, inclusive. Defaults to forty years back and five ahead. */
  fromYear?: number
  toYear?: number
  disabled?: boolean
  /** Marks both halves invalid, for a field showing an error. */
  invalid?: boolean
  className?: string
}

const pad = (month: number): string => String(month).padStart(2, '0')

function split(value: string): { month: string; year: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  return match ? { year: match[1], month: match[2] } : { year: '', month: '' }
}

export function MonthInput({
  value,
  onChange,
  locale,
  id,
  monthLabel,
  yearLabel,
  placeholder,
  clearLabel,
  fromYear,
  toYear,
  disabled,
  invalid,
  className,
}: MonthInputProps): JSX.Element {
  const [parts, setParts] = useState(() => split(value))
  useEffect(() => setParts(split(value)), [value])

  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
    return Array.from({ length: 12 }, (_, index) => ({
      value: pad(index + 1),
      label: format.format(new Date(Date.UTC(2000, index, 1))),
    }))
  }, [locale])

  const years = useMemo(() => {
    const now = new Date().getUTCFullYear()
    const last = toYear ?? now + 5
    const first = fromYear ?? now - 40
    const chosen = Number(parts.year)
    const range = Array.from({ length: last - first + 1 }, (_, index) => String(last - index))
    // A stored year outside the range is still shown, never silently dropped.
    return chosen && !range.includes(parts.year) ? [parts.year, ...range] : range
  }, [fromYear, toYear, parts.year])

  const set = (next: { month: string; year: string }): void => {
    setParts(next)
    if (next.month && next.year) onChange(`${next.year}-${next.month}`)
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Select value={parts.month || undefined} onValueChange={(month) => set({ ...parts, month })} disabled={disabled}>
        <SelectTrigger id={id} aria-label={monthLabel} aria-invalid={invalid || undefined} className="min-w-36 flex-1">
          <SelectValue placeholder={placeholder?.month} />
        </SelectTrigger>
        <SelectContent>
          {months.map((month) => (
            <SelectItem key={month.value} value={month.value}>
              {month.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={parts.year || undefined} onValueChange={(year) => set({ ...parts, year })} disabled={disabled}>
        <SelectTrigger aria-label={yearLabel} aria-invalid={invalid || undefined} className="min-w-24">
          <SelectValue placeholder={placeholder?.year} />
        </SelectTrigger>
        <SelectContent>
          {years.map((year) => (
            <SelectItem key={year} value={year}>
              {year}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {clearLabel && (parts.month || parts.year) ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={clearLabel}
          disabled={disabled}
          onClick={() => {
            setParts({ month: '', year: '' })
            onChange('')
          }}
        >
          <X className="size-4" aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
