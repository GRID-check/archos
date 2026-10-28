'use client'

import { useEffect, useState } from 'react'

/**
 * A text value, once it has stopped changing for `delayMs`. For a request
 * that follows a text field: the field answers every keystroke, the request
 * the word the reader settled on. An empty string is taken at once, so
 * clearing a search does not wait out the delay before the listing comes back.
 */
export function useDebouncedValue(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    if (value === settled) return
    if (value === '') {
      setSettled('')
      return
    }
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs, settled])

  return settled
}
