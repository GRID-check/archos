'use client'

import type { RefObject } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ContentTransform } from './content-transform'
import { anchoredTransform, clampZoom, doubleTapZoom, rubberBandZoom, twoFingerTapZoom } from './pdf-zoom'
import { classifyTap, type TapRecord } from './tap-gestures'

/** One wheel notch on a mouse is ~100px of delta; a trackpad pinch sends many small ones. */
const WHEEL_SENSITIVITY = 0.002
const MAX_WHEEL_DELTA = 100
/** How long the wheel has to rest before its zoom becomes layout. */
const WHEEL_COMMIT_MS = 160

/** Safari's trackpad pinch: not a wheel event, a proprietary gesture event. */
interface SafariGestureEvent extends UIEvent {
  scale: number
  clientX: number
  clientY: number
}

/**
 * What a finished zoom gesture asks of the viewer.
 *
 * `target` is the zoom to lay out; `shown` is the zoom on screen at that moment
 * (a pinch held past an end shows more than it may keep; a double tap shows the
 * old zoom and asks for a new one). The anchor is a point of the page stack,
 * in the stack's own pixels at the drawn zoom, and where on screen it is.
 */
export interface ZoomCommit {
  target: number
  shown: number
  clientX: number
  clientY: number
  contentX: number
  contentY: number
}

/** A press on one of these is the control's, never a tap on the sheet. */
const CONTROL_SELECTOR = 'button, a, input, textarea, select, label, [role="slider"], [data-zoom-tap="off"]'

const onControl = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(CONTROL_SELECTOR) !== null

interface Held {
  /** The zoom the stack is laid out at when the gesture took hold. */
  zoom: number
  /** The point taken hold of, in the stack's untransformed pixels. */
  point: { x: number; y: number }
  /** Where the stack's top-left corner was on screen then, and the frame's scroll. */
  origin: { x: number; y: number }
  scroll: { left: number; top: number }
}

/**
 * Pinch, double tap and Ctrl/Cmd + wheel zoom for one scroll frame.
 *
 *  - **Two fingers** on a touch screen, from TOUCH events: the one input that
 *    every touch browser delivers, and the one whose `touchmove` can be
 *    cancelled so the frame does not scroll under a pinch. The old path read
 *    pointer events AND Safari's `gesture*` events, and iOS fires both for one
 *    pinch, so two handlers wrote the zoom from two different bases.
 *    `gesture*` is now only listened to for a trackpad pinch with no finger on
 *    the glass (Safari on a Mac, an iPad's trackpad).
 *  - **Double tap** zooms in one step towards the finger, and back to the fit
 *    from the ceiling; a **two-finger tap** zooms one step out.
 *  - **Ctrl / Cmd + wheel**: a mouse with a modifier, and a trackpad pinch in
 *    Chromium and Firefox, which arrives as exactly this.
 *
 * While a gesture runs the stack is only TRANSFORMED (see `ContentTransform`):
 * the viewer lays out the new zoom once, on release, through `onCommit`. One
 * finger is never touched: the frame keeps `touch-action: pan-x pan-y`, so a
 * single finger scrolls natively, with the platform's own momentum.
 */
export function useZoomGestures(
  frameRef: RefObject<HTMLElement | null>,
  options: {
    enabled: boolean
    contentRef: RefObject<HTMLElement | null>
    transform: ContentTransform
    zoom: number
    maxZoom: number
    onCommit: (commit: ZoomCommit) => void
  },
): void {
  const { enabled, contentRef, transform, zoom, maxZoom, onCommit } = options
  const zoomRef = useRef(zoom)
  const maxRef = useRef(maxZoom)
  const onCommitRef = useRef(onCommit)

  useLayoutEffect(() => {
    zoomRef.current = zoom
    maxRef.current = maxZoom
    onCommitRef.current = onCommit
  }, [zoom, maxZoom, onCommit])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !enabled) return

    /** Take hold of the stack at a screen point, from rest. */
    const hold = (clientX: number, clientY: number): Held | null => {
      const content = contentRef.current
      if (!content) return null
      transform.finish()
      const rect = content.getBoundingClientRect()
      return {
        zoom: zoomRef.current,
        point: { x: clientX - rect.left, y: clientY - rect.top },
        origin: { x: rect.left, y: rect.top },
        scroll: { left: frame.scrollLeft, top: frame.scrollTop },
      }
    }

    /** Show the held stack at `shown`, its held point under (`clientX`, `clientY`). */
    const show = (held: Held, shown: number, clientX: number, clientY: number): void => {
      transform.preview(
        anchoredTransform({
          scale: shown / held.zoom,
          point: held.point,
          // A native scroll that started before the second finger landed keeps
          // moving the frame; the stack's corner moves with it.
          origin: {
            x: held.origin.x - (frame.scrollLeft - held.scroll.left),
            y: held.origin.y - (frame.scrollTop - held.scroll.top),
          },
          at: { x: clientX, y: clientY },
        }),
      )
    }

    const commit = (held: Held, target: number, shown: number, clientX: number, clientY: number): void => {
      onCommitRef.current({
        target: clampZoom(target, maxRef.current),
        shown,
        clientX,
        clientY,
        contentX: held.point.x,
        contentY: held.point.y,
      })
    }

    // ---- Touch: pinch, double tap, two-finger tap ------------------------

    let pinch: (Held & { distance: number; last: { raw: number; x: number; y: number } | null }) | null = null
    let press: TapRecord | null = null
    let lastTap: TapRecord | null = null

    const midpoint = (touches: TouchList): { x: number; y: number; distance: number } => {
      const a = touches[0]
      const b = touches[1]
      if (!a || !b) return { x: a?.clientX ?? 0, y: a?.clientY ?? 0, distance: 0 }
      return {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      }
    }

    const onPinchMove = (event: TouchEvent): void => {
      if (!pinch || event.touches.length < 2 || pinch.distance <= 0) return
      if (event.cancelable) event.preventDefault()
      const now = midpoint(event.touches)
      const raw = (pinch.zoom * now.distance) / pinch.distance
      pinch.last = { raw, x: now.x, y: now.y }
      show(pinch, rubberBandZoom(raw, maxRef.current), now.x, now.y)
      if (press) press.moved = true
    }

    const endPinch = (): void => {
      if (!pinch) return
      frame.removeEventListener('touchmove', onPinchMove)
      const ended = pinch
      pinch = null
      if (!ended.last) {
        transform.release()
        return
      }
      const { raw, x, y } = ended.last
      commit(ended, raw, rubberBandZoom(raw, maxRef.current), x, y)
    }

    const onTouchStart = (event: TouchEvent): void => {
      const count = event.touches.length
      if (count === 1) {
        const touch = event.touches[0]
        press =
          touch && !onControl(event.target)
            ? { time: event.timeStamp, x: touch.clientX, y: touch.clientY, fingers: 1, moved: false }
            : null
        return
      }
      if (count === 2 && !pinch) {
        const now = midpoint(event.touches)
        const held = hold(now.x, now.y)
        if (!held) return
        pinch = { ...held, distance: now.distance, last: null }
        if (press) {
          press.fingers = 2
          press.x = now.x
          press.y = now.y
        }
        // Non-passive only for as long as two fingers are down: a cancellable
        // `touchmove` on a scroller makes every scroll wait for the main thread.
        frame.addEventListener('touchmove', onPinchMove, { passive: false })
        return
      }
      // A third finger is nobody's gesture.
      press = null
    }

    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (!press || !touch || press.fingers !== 1) return
      if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) press.moved = true
    }

    const onTouchEnd = (event: TouchEvent): void => {
      if (pinch && event.touches.length < 2) endPinch()
      if (event.touches.length > 0 || !press) return
      const ended = { ...press }
      press = null
      const tap = classifyTap(ended, lastTap, event.timeStamp)
      lastTap = tap.kind === 'single' ? { ...ended, time: event.timeStamp } : null
      // A scroll, a hold or a lone tap asks nothing of the zoom.
      if (tap.kind !== 'double' && tap.kind !== 'two-finger') return
      const held = hold(ended.x, ended.y)
      if (!held) return
      const target = tap.kind === 'double' ? doubleTapZoom(held.zoom, maxRef.current) : twoFingerTapZoom(held.zoom, maxRef.current)
      if (Math.abs(target - held.zoom) < 1e-4) return
      if (event.cancelable) event.preventDefault()
      commit(held, target, held.zoom, ended.x, ended.y)
    }

    const onTouchCancel = (): void => {
      endPinch()
      press = null
    }

    // ---- Wheel ---------------------------------------------------------

    let wheel: (Held & { raw: number; at: { x: number; y: number } }) | null = null
    let wheelTimer: number | null = null
    const endWheel = (): void => {
      wheelTimer = null
      const ended = wheel
      wheel = null
      if (!ended) return
      const shown = clampZoom(ended.raw, maxRef.current)
      commit(ended, shown, shown, ended.at.x, ended.at.y)
    }
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      if (!wheel) {
        const held = hold(event.clientX, event.clientY)
        if (!held) return
        wheel = { ...held, raw: held.zoom, at: { x: event.clientX, y: event.clientY } }
      }
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY))
      wheel.raw = clampZoom(wheel.raw * Math.exp(-delta * WHEEL_SENSITIVITY), maxRef.current)
      show(wheel, wheel.raw, wheel.at.x, wheel.at.y)
      if (wheelTimer !== null) window.clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(endWheel, WHEEL_COMMIT_MS)
    }

    // ---- Safari's trackpad pinch -----------------------------------------

    let trackpad: (Held & { raw: number; at: { x: number; y: number } }) | null = null
    let fingersDown = 0
    const countFingers = (event: TouchEvent): void => {
      fingersDown = event.touches.length
    }
    const onGestureStart = (event: Event): void => {
      // Always: on iOS this is what would zoom the whole page instead.
      event.preventDefault()
      // A finger on the glass means the touch path has this one.
      if (fingersDown > 0) return
      const gesture = event as SafariGestureEvent
      const held = hold(gesture.clientX, gesture.clientY)
      if (held) trackpad = { ...held, raw: held.zoom, at: { x: gesture.clientX, y: gesture.clientY } }
    }
    const onGestureChange = (event: Event): void => {
      event.preventDefault()
      if (!trackpad) return
      const gesture = event as SafariGestureEvent
      trackpad.raw = trackpad.zoom * gesture.scale
      show(trackpad, rubberBandZoom(trackpad.raw, maxRef.current), trackpad.at.x, trackpad.at.y)
    }
    const onGestureEnd = (event: Event): void => {
      event.preventDefault()
      const ended = trackpad
      trackpad = null
      if (!ended) return
      commit(ended, ended.raw, rubberBandZoom(ended.raw, maxRef.current), ended.at.x, ended.at.y)
    }

    frame.addEventListener('wheel', onWheel, { passive: false })
    frame.addEventListener('touchstart', onTouchStart, { passive: true })
    frame.addEventListener('touchstart', countFingers, { passive: true })
    frame.addEventListener('touchmove', onTouchMove, { passive: true })
    frame.addEventListener('touchend', onTouchEnd, { passive: false })
    frame.addEventListener('touchend', countFingers, { passive: true })
    frame.addEventListener('touchcancel', onTouchCancel, { passive: true })
    frame.addEventListener('touchcancel', countFingers, { passive: true })
    frame.addEventListener('gesturestart', onGestureStart)
    frame.addEventListener('gesturechange', onGestureChange)
    frame.addEventListener('gestureend', onGestureEnd)
    return () => {
      if (wheelTimer !== null) window.clearTimeout(wheelTimer)
      frame.removeEventListener('wheel', onWheel)
      frame.removeEventListener('touchstart', onTouchStart)
      frame.removeEventListener('touchstart', countFingers)
      frame.removeEventListener('touchmove', onTouchMove)
      frame.removeEventListener('touchmove', onPinchMove)
      frame.removeEventListener('touchend', onTouchEnd)
      frame.removeEventListener('touchend', countFingers)
      frame.removeEventListener('touchcancel', onTouchCancel)
      frame.removeEventListener('touchcancel', countFingers)
      frame.removeEventListener('gesturestart', onGestureStart)
      frame.removeEventListener('gesturechange', onGestureChange)
      frame.removeEventListener('gestureend', onGestureEnd)
      transform.release()
    }
  }, [frameRef, contentRef, transform, enabled])
}
