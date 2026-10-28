/**
 * Where focus lands when an overlay opens under a finger.
 *
 * Radix moves focus to the first focusable thing inside a dialog or a sheet
 * when it opens. With a mouse or a keyboard that is right: the reader starts
 * where the work is. Under a finger it is wrong twice. A focused field raises
 * the keyboard over the sheet it belongs to before the reader has read the
 * question, and a focused control (the drawer's project pill, a sheet's first
 * button) can draw its keyboard ring on a phone, which reads as the overlay
 * pointing at one of its own controls for no reason. So the panel itself takes
 * the focus: a screen reader still lands inside it, Tab still starts there, and
 * the reader taps what they want when they are ready.
 *
 * `Dialog` and `Sheet` call this from `onOpenAutoFocus`, after the caller's own
 * handler, so a caller that directs the focus (`event.preventDefault()` and a
 * `focus()` of its own) keeps it.
 */

/** A finger drives the pointer: no hover, and a focused field raises a keyboard. */
export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

/** Under a finger, focus the overlay's panel instead of its first control. */
export function focusPanelUnderFinger(event: Event): void {
  if (event.defaultPrevented || !isCoarsePointer()) return
  event.preventDefault()
  const panel = event.currentTarget
  if (panel instanceof HTMLElement) panel.focus()
}
