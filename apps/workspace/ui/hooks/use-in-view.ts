'use client'

import { useEffect, useState, type RefCallback } from 'react'

/**
 * Whether an element is on screen now (or within `rootMargin` of it), NOT
 * latched: it goes back to false when the element scrolls away. The twin of
 * `useSeenOnce` (`./use-seen-once`), for work that has to happen
 * again each time the element comes back: the sentinel at the end of a paged
 * list asks for the next page whenever it is reached.
 *
 * A callback ref rather than a `RefObject`, so the observer attaches when the
 * node actually mounts. Without `IntersectionObserver` (old engines, SSR) the
 * answer stays false: the caller's fallback is an explicit control (a button),
 * never a loop that reads every page because nothing could say where the
 * reader is.
 */
export function useInView<T extends Element>({ rootMargin = '0px' }: { rootMargin?: string } = {}): [
  RefCallback<T>,
  boolean,
] {
  const [node, setNode] = useState<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (!node || typeof IntersectionObserver === 'undefined') {
      setInView(false)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1)
        if (entry) setInView(entry.isIntersecting)
      },
      { rootMargin }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, rootMargin])

  return [setNode, inView]
}
