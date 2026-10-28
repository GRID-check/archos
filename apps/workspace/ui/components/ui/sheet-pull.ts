'use client'

import * as React from 'react'
import { animate } from 'motion/react'

import { springGlide, useMotionToken } from '@/components/motion'

/**
 * Pull-to-dismiss, the gesture a bottom sheet promises the moment it draws a
 * grabber.
 *
 * Two surfaces pull: the page sheet (Archiv, Postfach), which is a motion.dev
 * element and drags through `useDragControls`, and the Dialog on a phone, which
 * Radix animates with CSS keyframes and so cannot be a motion element without
 * the keyframes and the drag fighting over `transform`. Both commit on the same
 * two numbers, defined here once: a pull feels like ONE gesture across the app
 * only if it commits at the same distance everywhere.
 */

/**
 * Past this much travel the release dismisses. About two grabber bands: a stray
 * touch never gets there, a deliberate pull always does.
 */
export const SHEET_DISMISS_DISTANCE_PX = 96

/** A flick at least this fast dismisses whatever the distance. */
export const SHEET_DISMISS_VELOCITY_PX_S = 600

/** A lift more than this long after the last move carries no flick. */
const FLICK_WINDOW_MS = 80

/** Whether a pull released at `offset` px, moving at `velocity` px/s, dismisses. */
export function pullDismisses(offset: number, velocity: number): boolean {
  return offset > SHEET_DISMISS_DISTANCE_PX || velocity > SHEET_DISMISS_VELOCITY_PX_S
}

interface Pull {
  pointerId: number
  panel: HTMLElement
  startY: number
  offset: number
  lastY: number
  lastTime: number
  velocity: number
}

type PullHandlers = Required<
  Pick<React.HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>
>

/**
 * Pointer handlers for a CSS-animated sheet's handle. The panel is the handle's
 * nearest `[data-slot="dialog-content"]`.
 *
 * The panel follows the finger 1:1 downward and refuses upward travel. On
 * release past {@link pullDismisses} it calls `dismiss`, leaving the panel where
 * the finger let go so the exit keyframe (`slide-out-to-bottom`, which has only
 * a `to` frame) continues from there instead of jumping back first. If the
 * dismissal is declined (an editor holding unsaved work routes the close through
 * its discard question) or the pull falls short, the panel returns on
 * `springGlide`: the reader's own gesture handed back, over a distance nobody
 * knew in advance, which is the case that spring is calibrated for. Under
 * reduced motion it returns in one frame.
 */
export function useSheetPull(dismiss: () => void): PullHandlers {
  const pull = React.useRef<Pull | null>(null)
  const snapBack = useMotionToken(springGlide)

  const settle = React.useCallback(
    (panel: HTMLElement, offset: number) => {
      if (offset <= 0) {
        panel.style.transform = ''
        return
      }
      void animate(panel, { y: [offset, 0] }, snapBack).then(() => {
        panel.style.transform = ''
      })
    },
    [snapBack]
  )

  return React.useMemo<PullHandlers>(
    () => ({
      onPointerDown: (event) => {
        if (event.button !== 0) return
        const panel = event.currentTarget.closest<HTMLElement>('[data-slot="dialog-content"]')
        if (!panel) return
        event.currentTarget.setPointerCapture?.(event.pointerId)
        pull.current = {
          pointerId: event.pointerId,
          panel,
          startY: event.clientY,
          offset: 0,
          lastY: event.clientY,
          lastTime: event.timeStamp,
          velocity: 0,
        }
      },
      onPointerMove: (event) => {
        const current = pull.current
        if (!current || current.pointerId !== event.pointerId) return
        // The release velocity is the LAST step's: a finger that pulled fast and
        // then came to rest before lifting is placing the sheet, not flicking it.
        const elapsed = event.timeStamp - current.lastTime
        const step = event.clientY - current.lastY
        if (step === 0) current.velocity = 0
        else if (elapsed > 0) current.velocity = (step / elapsed) * 1000
        current.lastY = event.clientY
        current.lastTime = event.timeStamp
        current.offset = Math.max(0, event.clientY - current.startY)
        current.panel.style.transform = `translateY(${current.offset}px)`
      },
      onPointerUp: (event) => {
        const current = pull.current
        if (!current || current.pointerId !== event.pointerId) return
        pull.current = null
        // A finger at rest sends no moves, so a lift long after the last one
        // is not a flick, however fast that last move was.
        const velocity = event.timeStamp - current.lastTime > FLICK_WINDOW_MS ? 0 : current.velocity
        if (!pullDismisses(current.offset, velocity)) {
          settle(current.panel, current.offset)
          return
        }
        dismiss()
        // A declined close leaves the panel open and mid-air: bring it back.
        requestAnimationFrame(() => {
          if (current.panel.isConnected && current.panel.dataset.state === 'open') {
            settle(current.panel, current.offset)
          }
        })
      },
      onPointerCancel: (event) => {
        const current = pull.current
        if (!current || current.pointerId !== event.pointerId) return
        pull.current = null
        settle(current.panel, current.offset)
      },
    }),
    [dismiss, settle]
  )
}
