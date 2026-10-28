'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { animate } from 'motion/react'
import { motionInstant, motionQuick, useMotionToken } from '@/components/motion'

/**
 * A list whose rows were REPLACED by a filter the reader just pressed fades
 * its new rows in, instead of swapping them in one frame.
 *
 * A status filter or a task filter changes most of what sits under it at once.
 * Landed in a single frame, the grid simply blinked into another grid and the
 * eye had no cue that the press caused it; faded on `motionQuick`, the change
 * reads as the answer to the press. Only the incoming state fades: the
 * outgoing one leaves in the same frame, because two lists cross-fading in one
 * place read as one garbled list, and waiting for an exit is dead air on a
 * control pressed many times in a row.
 *
 * Keyed: the frame fades only when `swapKey` changes, never on mount and never
 * on any other render (a row arriving by itself, a count updating). Opacity
 * only, so nothing reflows. Imperative, so the rows below keep their identity
 * (a keyed remount would throw away every card and its images). Reduced motion
 * gets the swap in one frame (`useMotionToken`).
 */
export function useSwapFade(frameRef: RefObject<HTMLElement | null>, swapKey: unknown): void {
  const transition = useMotionToken(motionQuick)
  const previousKey = useRef(swapKey)

  useLayoutEffect(() => {
    if (Object.is(previousKey.current, swapKey)) return
    previousKey.current = swapKey
    const frame = frameRef.current
    if (!frame || transition === motionInstant) return
    const controls = animate(frame, { opacity: [0, 1] }, transition)
    return () => {
      controls.stop()
      frame.style.opacity = ''
    }
  }, [swapKey, frameRef, transition])
}
