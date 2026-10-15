'use client'

import { useEffect, useState } from 'react'

/**
 * Whether the on-screen keyboard is up over the page.
 *
 * The phone tab bar stands down while this is true. The keyboard takes about
 * 340px of an 852px screen, the shell already shrinks to what is left
 * (`useVisualViewport`), and a bar riding on top of the keyboard would put five
 * navigation targets between the reader's thumb and the composer they are
 * typing into, on the one screen where height is scarcest.
 *
 * The keyboard itself is the signal, not the focus. A field can hold the
 * focus with no keyboard at all (a programmatic focus on iOS raises none, a
 * hardware keyboard needs none), and hiding the bar then would take the
 * navigation away for nothing. Two ways to see the keyboard, because the
 * browsers disagree about what it shrinks:
 *
 * - iOS Safari shrinks only the VISUAL viewport, so the layout viewport stays
 *   taller than it.
 * - Chromium with `interactive-widget=resizes-content` shrinks the layout
 *   viewport too, so nothing is left to compare; there the window has become
 *   shorter than it was at this width, while a text field has the focus.
 *
 * A field inside a dialog does not count: the dialog covers the bar anyway,
 * and hiding it would reflow the page underneath for nothing.
 */

/**
 * Occlusion below this is a browser toolbar collapsing, not a keyboard. The
 * smallest iPhone keyboard (landscape, no predictions) is well over 150px.
 */
const KEYBOARD_MIN_PX = 150
const ZOOM_EPSILON = 0.01

/** The fields a keyboard types into. A checkbox or a button takes focus without one. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** Overlays cover the bar themselves; a field inside one leaves the page alone. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"]'

export function isTypingTarget(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.closest(OVERLAY_SELECTOR)) return false
  if (element.isContentEditable) return true
  if (element instanceof HTMLTextAreaElement) return !element.readOnly
  if (element instanceof HTMLInputElement)
    return !element.readOnly && !NON_TEXT_INPUTS.has(element.type)
  return false
}

export interface ViewportReading {
  /** `document.documentElement.clientHeight`: the layout viewport. */
  layoutHeight: number
  /** `visualViewport.height`, or the layout height where there is none. */
  visualHeight: number
  visualScale: number
  /** The tallest layout viewport seen at the current width. */
  tallestLayoutHeight: number
  /** A text field outside any dialog has the focus. */
  fieldFocused: boolean
}

/** Pure, so both browsers' shapes are tested without either. */
export function keyboardIsUp(reading: ViewportReading): boolean {
  if (!reading.fieldFocused) return false
  const zoomed = Math.abs(reading.visualScale - 1) >= ZOOM_EPSILON
  if (!zoomed && reading.layoutHeight - reading.visualHeight > KEYBOARD_MIN_PX) return true
  return reading.tallestLayoutHeight - reading.layoutHeight > KEYBOARD_MIN_PX
}

export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false)

  useEffect(() => {
    let frame = 0
    // Per width, so turning the phone does not read as a keyboard.
    const tallest = new Map<number, number>()
    const update = (): void => {
      frame = 0
      const root = document.documentElement
      const layoutHeight = root.clientHeight
      const width = root.clientWidth
      const fieldFocused = isTypingTarget(document.activeElement)
      // Only a page without the focus in a field says how tall the screen is.
      if (!fieldFocused) tallest.set(width, Math.max(tallest.get(width) ?? 0, layoutHeight))
      const viewport = window.visualViewport
      setUp(
        keyboardIsUp({
          layoutHeight,
          visualHeight: viewport?.height ?? layoutHeight,
          visualScale: viewport?.scale ?? 1,
          tallestLayoutHeight: tallest.get(width) ?? layoutHeight,
          fieldFocused,
        })
      )
    }
    // Coalesced to a frame: on `focusout` the next element has not taken the
    // focus yet, and the keyboard fires a resize per animation frame.
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    update()
    document.addEventListener('focusin', schedule)
    document.addEventListener('focusout', schedule)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    return () => {
      document.removeEventListener('focusin', schedule)
      document.removeEventListener('focusout', schedule)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [])

  return up
}
