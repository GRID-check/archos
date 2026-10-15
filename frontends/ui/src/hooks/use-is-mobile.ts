'use client'

import { useSyncExternalStore } from 'react'

/**
 * The breakpoint queries, for the layout decisions CSS cannot make alone
 * (which of two places a control renders in, an inline width animation in the
 * chat shell).
 *
 * `globals.css` redefines Tailwind's `md`, `max-md` and adds `phone` with these
 * exact strings, and `breakpoints.spec.ts` holds the two copies to one, so a
 * component that asks `useIsMobile()` and a class that says `md:` can never
 * disagree about the same screen. The why (a phone on its side has 852px of
 * width and 393px of height, and is still a phone) is written once, there.
 */

/** A phone held sideways: a finger, at most 500px tall, narrower than `lg`. */
export const PHONE_ON_ITS_SIDE_QUERY = '(pointer: coarse) and (height <= 31.25rem) and (width < 64rem)'

/** The phone shell: below `md`, or a phone on its side. `md:` is its complement. */
export const MOBILE_LAYOUT_QUERY = `(width < 48rem), ${PHONE_ON_ITS_SIDE_QUERY}`

/** A phone-sized screen: below `sm`, or a phone on its side. The `phone:` variant. */
export const PHONE_QUERY = `(width < 40rem), ${PHONE_ON_ITS_SIDE_QUERY}`

const subscribe = (onStoreChange: () => void): (() => void) => {
  const mql = window.matchMedia(MOBILE_LAYOUT_QUERY)
  mql.addEventListener('change', onStoreChange)
  return () => mql.removeEventListener('change', onStoreChange)
}

const getSnapshot = (): boolean => window.matchMedia(MOBILE_LAYOUT_QUERY).matches

// SSR renders the desktop layout; the client corrects on hydration.
const getServerSnapshot = (): boolean => false

/** Whether the phone shell is showing: exactly when `md:` does not apply. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
