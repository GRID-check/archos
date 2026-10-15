/**
 * A tap near an inline citation marker opens it.
 *
 * See `lib/nearest-marker.ts` for why the catchment is resolved at the tap
 * rather than drawn around each marker. This is the handler: one per answer,
 * on its frame, only on a coarse pointer (a mouse hits what it points at), and
 * only for a tap that landed on nothing pressable. A link, a button, a
 * disclosure summary or a field is never overridden, so the marker's reach
 * cannot steal a tap from a control.
 */

import type { MouseEvent } from 'react'
import { nearestMarkerIndex } from '../lib/nearest-marker'

/** What a tap on is already its own answer. */
const PRESSABLE_SELECTOR =
  'a[href], button, summary, input, textarea, select, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [data-no-citation-tap]'

const MARKER_SELECTOR = 'button[data-citation-marker]'

/**
 * The `onClick` of an answer's frame. A handler rather than an effect on a ref:
 * the frame mounts after the first render of an answer that began blank, and an
 * effect keyed on the ref would never have seen it.
 */
export const handleNearestCitationTap = (event: MouseEvent<HTMLElement>): void => {
  if (event.defaultPrevented) return
  if (typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: coarse)').matches) return
  const frame = event.currentTarget
  const target = event.target
  // React bubbles through portals: a tap in the citation sheet is not a tap in
  // the answer, and must not reach for the marker behind its scrim.
  if (!(target instanceof Element) || !frame.contains(target) || target.closest(PRESSABLE_SELECTOR)) return
  // A drag that selected text is a selection, not a tap.
  if (window.getSelection()?.toString()) return
  const markers = Array.from(frame.querySelectorAll<HTMLButtonElement>(MARKER_SELECTOR))
  if (markers.length === 0) return
  const index = nearestMarkerIndex(
    event.clientX,
    event.clientY,
    markers.map((marker) => marker.getBoundingClientRect())
  )
  if (index < 0) return
  markers[index]?.click()
}
