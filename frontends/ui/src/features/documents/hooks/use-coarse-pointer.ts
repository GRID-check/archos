'use client'

import { useSyncExternalStore } from 'react'

/**
 * Whether the primary pointer is a finger: the question the photo entries ask,
 * because a camera and a photo library are what a phone or a tablet holds.
 *
 * `useMediaQuery` with a guard: an engine with no `matchMedia` (jsdom, an old
 * embedded view) answers `false`, the desktop shape, instead of throwing.
 */
const QUERY = '(pointer: coarse)'

const hasMatchMedia = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function'

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {}
  const mql = window.matchMedia(QUERY)
  mql.addEventListener?.('change', onChange)
  return () => mql.removeEventListener?.('change', onChange)
}

const getSnapshot = (): boolean => hasMatchMedia() && window.matchMedia(QUERY).matches

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
