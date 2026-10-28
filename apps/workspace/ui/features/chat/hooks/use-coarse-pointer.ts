/**
 * Whether the primary pointer is a finger.
 *
 * The Touch rule is on this axis and never a viewport breakpoint. Used where CSS
 * cannot decide alone: which of two presentations (a popover beside a marker, a
 * bottom sheet from the thumb's edge) is mounted, since rendering both would put
 * two copies of the passage in the DOM.
 *
 * Unlike `useMediaQuery` this tolerates an environment with no `matchMedia`
 * (jsdom, a server render): there the pointer is a mouse, which is what every
 * existing test of an answer assumes.
 */

'use client'

import { useSyncExternalStore } from 'react'

const QUERY = '(pointer: coarse)'

const subscribe = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

const getSnapshot = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches

export const useCoarsePointer = (): boolean => useSyncExternalStore(subscribe, getSnapshot, () => false)
