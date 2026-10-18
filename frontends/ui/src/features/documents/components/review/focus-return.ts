import { useEffect, useRef, type RefObject } from 'react'

/**
 * Where the focus goes back to in the review (and on a Postfach row, which
 * answers a mark with the review's own composer), for a reader on the keyboard:
 * a card, the crosshair or the cursor chat took it from something, and gives
 * it back there when it closes, unless the reader has put it somewhere else
 * meanwhile. (`shared/hooks/use-panel-focus.ts` does this for a panel that
 * always takes the focus; a review card takes it only when a key opened it,
 * and one card follows another under J without giving it back in between.)
 */

/**
 * What has the focus now, to give it back later; `current` when that is a
 * card or the crosshair (a step from one card to the next keeps the first
 * trigger) or nothing.
 */
export function keepTrigger(current: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement &&
    active !== document.body &&
    !active.closest('[data-review-card], [data-testid="review-aim"]')
    ? active
    : current
}

/** Whether the focus was lost with what held it: it is on nothing, or on the review itself. */
export function focusLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || (active instanceof HTMLElement && active.dataset.testid === 'document-review')
}

/** Give the focus back to `trigger` when it was lost with what closed ({@link focusLost}). */
export function restoreFocus(trigger: Element | null): void {
  if (!(trigger instanceof HTMLElement) || !trigger.isConnected) return
  if (focusLost()) trigger.focus({ preventScroll: true })
}

/**
 * The focus back to the control that opened an editor in place, when that
 * editor closes (sent, saved, „Abbrechen“, Escape): a reply's rewording in its
 * thread, the answer box on a Postfach row. The editor took the control's
 * place, so its field goes with it and the focus would fall to the page.
 * `open` is whether the editor is out; the ref goes on the control („Antworten“,
 * the reply's ⋯), which is drawn again where the editor stood.
 */
export function useFocusBackOnClose<T extends HTMLElement>(open: boolean): RefObject<T | null> {
  const control = useRef<T | null>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) restoreFocus(control.current)
    wasOpen.current = open
  }, [open])
  return control
}
