'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * Whether a CSS media query matches, kept current as the window changes.
 *
 * For a layout decision CSS cannot make alone: which of two places a control
 * is rendered in, when rendering it in both would give it two DOM nodes and
 * two tab stops. Prefer a Tailwind variant whenever the difference is styling.
 * `useIsMobile` is the fixed `md` instance of this.
 *
 * The server renders `false`; the client corrects on hydration.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onStoreChange)
      return () => mql.removeEventListener('change', onStoreChange)
    },
    [query],
  )
  const getSnapshot = useCallback((): boolean => window.matchMedia(query).matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
