'use client'

import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * Report an element's height to a callback, before paint and on every change.
 *
 * Returns a callback ref. The chat toolbar's height is not a constant: it is
 * one row on a desktop, two on a phone, and a third while the link is gone, and
 * the transcript under it has to start below whichever it is. Measured on
 * arrival (layout effect, so the first paint already clears it) and observed
 * after, so a wrapped title or a connection line moves the transcript with it.
 *
 * `ResizeObserver` is absent in jsdom; there the arrival reading is all there is.
 */
export function useHeaderHeight(
  onHeight: ((heightPx: number) => void) | undefined
): (node: HTMLElement | null) => void {
  const callbackRef = useRef(onHeight)
  const observerRef = useRef<ResizeObserver | null>(null)

  useLayoutEffect(() => {
    callbackRef.current = onHeight
  }, [onHeight])

  return useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return
    const report = () => {
      const height = node.getBoundingClientRect().height
      if (height > 0) callbackRef.current?.(height)
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    observerRef.current = new ResizeObserver(report)
    observerRef.current.observe(node)
  }, [])
}
