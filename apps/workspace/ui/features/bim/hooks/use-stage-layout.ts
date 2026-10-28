'use client'

/**
 * Which arrangement of chrome the stage draws, decided by the glass it is on.
 *
 * Three arrangements, not a breakpoint:
 *
 * - `desktop` — the floating dock at the bottom, the rail on the left, the
 *   selection as a card on the right. Everything a mouse wants.
 * - `phone` — a portrait phone. A labelled tool bar, and everything that is
 *   not a tool (the selection, the levels, the rest) arrives as a bottom sheet
 *   that leaves the building above it.
 * - `phone-landscape` — the same phone turned. 393 px of height cannot carry a
 *   bar AND a sheet, so the tools become a column on the left edge and the
 *   sheet a panel on the right, which is what the width is for.
 *
 * Landscape is its own query rather than "wider than `sm`": an iPhone turned
 * sideways is 852 px wide, past every width breakpoint, and used to get the
 * desktop chrome — a 24 px inset around a dialog whose corner the notch sits
 * in, and a nine-glyph dock with the model squeezed into 300 px of height. The
 * test for "a phone on its side" is a finger, a landscape orientation and
 * little height; a half-width desktop window has none of the three.
 *
 * The server renders `desktop`; the stage is portalled into a dialog that only
 * exists on the client, so there is no hydration to disagree with.
 */

import { useMediaQuery } from '@/hooks/use-media-query'

export type StageLayout = 'desktop' | 'phone' | 'phone-landscape'

/** Narrower than Tailwind's `sm`. */
export const PHONE_QUERY = '(max-width: 639px)'
/** A touch device on its side: too short for a bar AND a sheet. */
export const PHONE_LANDSCAPE_QUERY =
  '(pointer: coarse) and (orientation: landscape) and (max-height: 500px)'

/** The decision, separated from the media queries so it can be tested as a table. */
export function resolveStageLayout(phone: boolean, landscape: boolean): StageLayout {
  // Landscape first: a short landscape viewport can also be narrow (a small
  // phone, a split view), and a bottom sheet there leaves no building at all.
  if (landscape) return 'phone-landscape'
  return phone ? 'phone' : 'desktop'
}

export function useStageLayout(): StageLayout {
  const phone = useMediaQuery(PHONE_QUERY)
  const landscape = useMediaQuery(PHONE_LANDSCAPE_QUERY)
  return resolveStageLayout(phone, landscape)
}
