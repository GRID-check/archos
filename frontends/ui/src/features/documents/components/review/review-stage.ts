/**
 * The free stage of the review: the canvas less what floats over its edges.
 * At the foot sit the viewer's pill (on a touch screen the tools' row above
 * it) and the chips of who is out of view below; at the head the line of
 * who is followed, who is above and what the tool does. A card on the sheet
 * lives in the page's own scroller, under all of these (the scroller is a
 * stacking context of its own), so no z-index lifts it over them: it has to
 * stay out of their way instead (`fitCard`), and a chip that would still lie
 * over it steps aside (`covers`).
 */

import { createContext, useContext, useLayoutEffect, type RefObject } from 'react'

/** A vertical band in the window, in CSS pixels. */
export interface Band {
  top: number
  bottom: number
}

/** How much of the canvas's foot the toolbars and the chips below them take: with a pointer, and on a touch screen. */
export const STAGE_FOOT = { pointer: 100, touch: 176 } as const

/** The line at the canvas's head (following, who is above, the tool's hint). */
export const STAGE_HEAD = 12

/** The free stage, measured when asked; null while there is no canvas. */
export type StageBounds = () => Band | null

/** The review's free stage, for the cards drawn on its pages. Null outside the review (the file preview's inline layer). */
export const ReviewStageContext = createContext<StageBounds | null>(null)

/** The least a card under its mark keeps when the stage below the mark is shorter: its header, a line, and the reply field. */
export const MIN_CARD_HEIGHT = 200

/** How much of a card stays above its hairline when the card moves up: the hairline keeps pointing into the card. */
const HAIRLINE_KEEP = 28

/** How a card keeps inside the free stage: how far it moves up from where it hangs, and how tall it may grow. */
export interface CardFit {
  shift: number
  maxHeight: number
}

/**
 * Where a card fits, in the window's pixels. `top` is where the card hangs
 * (beside its mark, at the mark's top), `height` how tall it is drawn.
 *
 * Never taller than the stage: past that its thread scrolls inside it. Beside
 * its mark (`side`) a card that would run into the foot moves up, never past
 * the head and never so far that its hairline leaves it. Under its mark it
 * cannot move up without covering what it is about, so it gets shorter
 * instead, down to {@link MIN_CARD_HEIGHT}.
 */
export function fitCard(top: number, height: number, stage: Band, side: boolean): CardFit {
  const room = Math.max(0, stage.bottom - stage.top)
  if (!side) return { shift: 0, maxHeight: Math.min(room, Math.max(MIN_CARD_HEIGHT, stage.bottom - top)) }
  const overflow = top + Math.min(height, room) - stage.bottom
  return { shift: Math.max(0, Math.min(overflow, top - stage.top, height - HAIRLINE_KEEP)), maxHeight: room }
}

/** Whether two boxes in the window overlap: a chip that would lie over the open card. */
export function covers(
  a: { top: number; bottom: number; left: number; right: number },
  b: { top: number; bottom: number; left: number; right: number }
): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/**
 * Keep the card at `ref` inside the review's free stage ({@link fitCard}), as
 * it grows, as the page scrolls and as the window changes. Written straight to
 * the card's custom properties (`--card-shift`, `--card-max-height`), so a
 * pointer frame or a scroll never re-renders the thread.
 */
export function useCardFit(ref: RefObject<HTMLElement | null>, placement: 'right' | 'left' | 'below' | 'detached' | null): void {
  const stage = useContext(ReviewStageContext)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !stage || !placement) return
    const side = placement === 'right' || placement === 'left'
    let frame = 0
    const measure = () => {
      frame = 0
      const bounds = stage()
      if (!bounds) return
      const shifted = Number.parseFloat(node.style.getPropertyValue('--card-shift')) || 0
      // `offsetHeight`, not the box: the card's entrance scales it, and the scale is no part of its height.
      const fit = fitCard(node.getBoundingClientRect().top + shifted, node.offsetHeight, bounds, side)
      node.style.setProperty('--card-max-height', `${fit.maxHeight}px`)
      node.style.setProperty('--card-shift', `${fit.shift}px`)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(node)
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref, stage, placement])
}
