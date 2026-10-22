'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * Whether a CSS media query matches, kept current as the window changes.
 *
 * For a layout decision CSS cannot make alone: which of two places a control
 * is rendered in, when rendering it in both would give it two DOM nodes and
 * two tab stops. Prefer a Tailwind variant whenever the difference is styling.
 * `useIsMobile` is the fixed `md` instance of this. A breakpoint question
 * passes one of the queries exported from `use-is-mobile.ts` rather than a
 * fresh `(max-width: …)`: those are what `md:` and `phone:` mean in CSS, and a
 * hand-written width forgets that a phone on its side is still a phone.
 *
 * The server renders `false`; the client corrects on hydration. Where there
 * is no `matchMedia` at all (jsdom, an embedded browser) it stays `false`.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onStoreChange)
      return () => mql.removeEventListener('change', onStoreChange)
    },
    [query],
  )
  const getSnapshot = useCallback(
    (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    [query],
  )
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
