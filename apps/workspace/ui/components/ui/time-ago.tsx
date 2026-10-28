'use client'

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { OFFICE_TIME_ZONE, formatAbsoluteTime, formatRelativeTime } from '@/lib/format'

/**
 * Time that is deterministic during SSR/hydration, relative only after mount.
 *
 * `formatRelativeTime` depends on `now`, so server and client render different
 * strings and React warns. Suppressing the warning hides the cause. This
 * component renders the absolute time on the server and on the first client
 * pass, then swaps to relative after mount — no mismatch, no suppression. The
 * absolute time is pinned to the office zone: the server runs in UTC and the
 * browser in the reader's zone, so an unpinned `Intl` string differs between
 * the two (React error #418).
 */
export function TimeAgo({ date, locale, className }: { date: string; locale: string; className?: string }): JSX.Element {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <time dateTime={date} title={formatAbsoluteTime(date, locale, OFFICE_TIME_ZONE)} className={className}>
      {mounted ? formatRelativeTime(date, locale) : formatAbsoluteTime(date, locale, OFFICE_TIME_ZONE)}
    </time>
  )
}
