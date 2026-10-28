'use client'

import { useEffect } from 'react'

/**
 * The CSS variable the app shell sizes itself by while the on-screen keyboard
 * covers part of the screen: `h-[var(--visual-viewport-height,100dvh)]`.
 * Absent the rest of the time, so the shell falls back to `100dvh`.
 */
export const VISUAL_VIEWPORT_HEIGHT_VAR = '--visual-viewport-height'

/**
 * Below this much occlusion the visual viewport counts as the whole layout
 * viewport. Sub-pixel rounding differs between the two, and a variable that
 * flickers on and off by half a pixel is a reflow for nothing.
 */
const OCCLUSION_THRESHOLD_PX = 1

/** Pinch zoom also shrinks the visual viewport; that is not a keyboard. */
const ZOOM_EPSILON = 0.01

/**
 * Surfaces that float above the shell in their own fixed box: dialogs (and the
 * sheets built on them), vaul drawers, Radix popovers and menus. A field inside
 * one is positioned against the screen, not the shell, so only Safari's pan can
 * bring it above the keyboard.
 */
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [data-vaul-drawer], [data-radix-popper-content-wrapper]'

/**
 * Whether the focused element lives in the shell frame, where cancelling
 * Safari's pan is right because the shell itself now fits above the keyboard.
 */
function focusIsInShell(): boolean {
  const focused = document.activeElement
  return !(focused instanceof Element && focused.closest(OVERLAY_SELECTOR) !== null)
}

/**
 * Sizes the app shell to the part of the screen the keyboard leaves visible,
 * on browsers that do not do it themselves.
 *
 * `interactiveWidget: 'resizes-content'` (app/layout.tsx) makes Chromium shrink
 * the layout viewport when the keyboard opens, so `100dvh` already means "above
 * the keyboard" there. iOS Safari ignores that setting: the keyboard shrinks
 * only the VISUAL viewport, `100dvh` keeps the full screen, the composer sits
 * behind the keyboard, and Safari pans the whole document up to reveal the
 * focused field — the shell's own chrome half off-screen and the transcript at
 * a position nothing in our code chose.
 *
 * While the visual viewport is shorter than the layout viewport (and not
 * because of pinch zoom), this publishes its height as
 * {@link VISUAL_VIEWPORT_HEIGHT_VAR} on `<html>` and scrolls the document back
 * to the top, which cancels Safari's pan: the shell now fits above the keyboard
 * and nothing is left to reveal. The scroll is left alone while the focus is in
 * a dialog, drawer or popover, which the pan is there to reveal (see
 * {@link OVERLAY_SELECTOR}). When the keyboard closes the variable is
 * removed. On Chromium with `resizes-content` the two viewports shrink
 * together, so this never engages; on desktop they are equal; where
 * `visualViewport` does not exist it does nothing at all.
 *
 * Writes go straight to the DOM, coalesced to one per frame, with no React
 * state: the keyboard animates over ~250ms and fires a resize per frame, and a
 * re-render of the whole shell per frame would be the jank this removes. Mount
 * it ONCE, in the shell (`AppShellChrome`) — the variable is document-global.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const root = document.documentElement
    let frame = 0

    const apply = (): void => {
      frame = 0
      const layoutHeight = root.clientHeight
      const occluded =
        Math.abs(viewport.scale - 1) < ZOOM_EPSILON &&
        layoutHeight - viewport.height > OCCLUSION_THRESHOLD_PX
      if (!occluded) {
        root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR)
        return
      }
      root.style.setProperty(VISUAL_VIEWPORT_HEIGHT_VAR, `${viewport.height}px`)
      // Only for a field in the shell. A field in a dialog, a drawer or a
      // popover is fixed to the screen, so a shorter shell does not move it,
      // and the pan is the only thing that reveals it: resetting it on every
      // scroll would fight Safari for the field's position frame by frame.
      if (!focusIsInShell()) return
      if (window.scrollY !== 0 || viewport.offsetTop !== 0) window.scrollTo(0, 0)
    }

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(apply)
    }

    apply()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    return () => {
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
      root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR)
    }
  }, [])
}

/**
 * The variable a fitted overlay sets for its bottom inset: `0px` while the
 * keyboard covers the home indicator, absent otherwise, so a composer at the
 * overlay's foot pads by `var(--overlay-inset-bottom, env(safe-area-inset-bottom))`.
 */
export const OVERLAY_INSET_BOTTOM_VAR = '--overlay-inset-bottom'

/**
 * Keeps one full-height overlay (a side sheet with a composer at its foot)
 * exactly on the part of the screen the on-screen keyboard leaves visible.
 *
 * {@link useVisualViewport} fits the SHELL, and leaves Safari's pan alone for a
 * field inside a dialog, because a fixed overlay does not move when the shell
 * shrinks. That leaves the overlay as tall as the layout viewport: on an iPhone
 * the keyboard covers its bottom third, the composer with it, and Safari pans
 * the whole screen to reveal the field, the overlay's header off the top. This
 * moves and sizes the overlay with the visual viewport (`top = offsetTop`,
 * `height = height`), so the field sits on the keyboard's edge whether or not
 * Safari pans, and the header stays in view.
 *
 * Inline styles on the node, coalesced to a frame, no React state (the keyboard
 * fires a resize per animation frame). Nothing happens while the two viewports
 * agree: desktop, Chromium under `resizes-content`, pinch zoom. Pass the node
 * from a callback ref; `null` (the overlay closed) does nothing.
 */
export function useFitToVisualViewport(node: HTMLElement | null): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport || !node) return

    let frame = 0
    const clear = (): void => {
      node.style.removeProperty('top')
      node.style.removeProperty('height')
      node.style.removeProperty(OVERLAY_INSET_BOTTOM_VAR)
    }
    const apply = (): void => {
      frame = 0
      const occluded =
        Math.abs(viewport.scale - 1) < ZOOM_EPSILON &&
        document.documentElement.clientHeight - viewport.height > OCCLUSION_THRESHOLD_PX
      if (!occluded) {
        clear()
        return
      }
      node.style.top = `${viewport.offsetTop}px`
      node.style.height = `${viewport.height}px`
      // The keyboard covers the home indicator: there is no inset left to clear.
      node.style.setProperty(OVERLAY_INSET_BOTTOM_VAR, '0px')
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(apply)
    }

    apply()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    return () => {
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
      clear()
    }
  }, [node])
}
