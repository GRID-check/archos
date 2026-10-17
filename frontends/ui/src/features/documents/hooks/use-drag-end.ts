'use client'

import { useEffect, useRef } from 'react'

/** Whether a `dragleave` is the drag leaving the window rather than one element for another. */
export function leftTheWindow(event: DragEvent): boolean {
  if (event.relatedTarget !== null) return false
  const { clientX: x, clientY: y } = event
  return x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight
}

/**
 * Call `onEnd` when the drag in progress ends, however it ends, while `active`.
 *
 * A drop target's highlight was cleared by its own `dragleave`, and an
 * upload overlay by a counter of enters and leaves. Neither hears a drag that
 * ends somewhere else: a drop on a child that claims it and stops it there, a
 * drop on another zone, a drag that leaves the window and is released over the
 * desktop. The overlay then stayed up over the workspace until the next drag.
 *
 * So the end is heard where every drag ends: a `drop` or `dragend` on the
 * window, in the CAPTURE phase, which no zone can stop, and a `dragleave` that
 * leaves the viewport. `onEnd` need not be stable.
 */
export function useDragEnd(active: boolean, onEnd: () => void): void {
  const latest = useRef(onEnd)
  latest.current = onEnd
  useEffect(() => {
    if (!active) return
    const end = () => latest.current()
    const leave = (event: DragEvent) => {
      if (leftTheWindow(event)) end()
    }
    window.addEventListener('drop', end, true)
    window.addEventListener('dragend', end, true)
    document.addEventListener('dragleave', leave, true)
    return () => {
      window.removeEventListener('drop', end, true)
      window.removeEventListener('dragend', end, true)
      document.removeEventListener('dragleave', leave, true)
    }
  }, [active])
}
