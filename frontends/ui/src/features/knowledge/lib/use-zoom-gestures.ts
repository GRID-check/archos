'use client'

import type { RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'

/** One wheel notch on a mouse is ~100px of delta; a trackpad pinch sends many small ones. */
const WHEEL_SENSITIVITY = 0.002
const MAX_WHEEL_DELTA = 100

/** Safari's trackpad pinch: not a wheel event, a proprietary gesture event. */
interface SafariGestureEvent extends UIEvent {
  scale: number
  clientX: number
  clientY: number
}

/**
 * Pinch and Ctrl/Cmd + wheel zoom on one scroll frame, reported as a target
 * zoom plus the client point it should be anchored at. The caller owns what an
 * anchor means for its own layout.
 *
 *  - **Ctrl / Cmd + wheel** — a mouse with a modifier, and a trackpad pinch in
 *    Chromium and Firefox, which arrives as exactly this.
 *  - **Safari's `gesture*` events** — its trackpad pinch, which otherwise
 *    zooms the whole page instead of the document.
 *  - **Two fingers** on a touch screen, from pointer events. The frame keeps
 *    `touch-action: pan-x pan-y`, so one finger still scrolls natively and the
 *    browser never zooms the page instead.
 *
 * The listeners are bound once per frame and read the live zoom from a ref, so
 * a pinch that re-renders the viewer every frame does not re-bind them every
 * frame. The same gestures the Fassungen comparison's stage answers
 * (`use-stage-gestures.ts`), without its mouse-drag pan: here a drag selects
 * text, which is what a reader of a Bescheid uses it for.
 */
export function useZoomGestures(
  frameRef: RefObject<HTMLElement | null>,
  options: { enabled: boolean; zoom: number; onZoom: (zoom: number, clientX: number, clientY: number) => void },
): void {
  const { enabled, zoom, onZoom } = options
  const zoomRef = useRef(zoom)
  const onZoomRef = useRef(onZoom)

  useLayoutEffect(() => {
    zoomRef.current = zoom
    onZoomRef.current = onZoom
  }, [zoom, onZoom])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !enabled) return

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY))
      onZoomRef.current(zoomRef.current * Math.exp(-delta * WHEEL_SENSITIVITY), event.clientX, event.clientY)
    }

    let gestureStart = 1
    const onGestureStart = (event: Event): void => {
      event.preventDefault()
      gestureStart = zoomRef.current
    }
    const onGestureChange = (event: Event): void => {
      event.preventDefault()
      const gesture = event as SafariGestureEvent
      onZoomRef.current(gestureStart * gesture.scale, gesture.clientX, gesture.clientY)
    }

    const touches = new Map<number, { x: number; y: number }>()
    let pinch: { distance: number; zoom: number } | null = null
    const spread = (): { distance: number; x: number; y: number } => {
      const [a, b] = [...touches.values()]
      if (!a || !b) return { distance: 0, x: 0, y: 0 }
      return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size === 2) pinch = { distance: spread().distance, zoom: zoomRef.current }
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (!touches.has(event.pointerId)) return
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (!pinch || touches.size !== 2 || pinch.distance <= 0) return
      const now = spread()
      onZoomRef.current((pinch.zoom * now.distance) / pinch.distance, now.x, now.y)
    }
    const onPointerEnd = (event: PointerEvent): void => {
      touches.delete(event.pointerId)
      if (touches.size < 2) pinch = null
    }

    frame.addEventListener('wheel', onWheel, { passive: false })
    frame.addEventListener('gesturestart', onGestureStart)
    frame.addEventListener('gesturechange', onGestureChange)
    frame.addEventListener('pointerdown', onPointerDown)
    frame.addEventListener('pointermove', onPointerMove)
    frame.addEventListener('pointerup', onPointerEnd)
    frame.addEventListener('pointercancel', onPointerEnd)
    return () => {
      frame.removeEventListener('wheel', onWheel)
      frame.removeEventListener('gesturestart', onGestureStart)
      frame.removeEventListener('gesturechange', onGestureChange)
      frame.removeEventListener('pointerdown', onPointerDown)
      frame.removeEventListener('pointermove', onPointerMove)
      frame.removeEventListener('pointerup', onPointerEnd)
      frame.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [frameRef, enabled])
}
